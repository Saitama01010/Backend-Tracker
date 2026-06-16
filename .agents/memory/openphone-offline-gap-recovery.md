---
name: OpenPhone offline-gap sync recovery
description: How to recover quo/phone stats after the app has been offline for days and the dashboard shows 0 calls
---

# Symptom
Dashboard shows 0 calls for today even though workflows are running. `/api/quo/stats` returns empty teamStats / totalRows 0, and `/api/quo/sync-state` shows `lastSyncedAt` stuck days in the past.

# Root cause
When the app has been offline for a long stretch (e.g. ~8 days), on restart `startBackgroundSync` fires TWO syncs concurrently:
- a hardcoded 2-day backfill, and
- an incremental whose window = time-since-`lastSyncedAt` (days → **thousands** of unique participant call-fetches).

Both share OpenPhone's aggressive rate limit (nearly every `quoFetch` gets HTTP 429, retried with backoff). Worse, `runSync` is **all-or-nothing**: it buffers every call in memory and only writes to `phone_calls` AFTER every task finishes. So a multi-thousand-task sync writes NOTHING for hours, then dumps. That is why stats stay at 0.

`quoFetch` retries 429 forever (no max attempts), so syncs don't fail — they just crawl. The DB `is_syncing` flag is NOT set true during a run (only written at completion), so sync-state showing `is_syncing:false` does not mean idle.

# Fix (operational, no code change)
1. Advance the sync cursor so the incremental window collapses to its 30-min minimum:
   `UPDATE phone_sync_state SET last_synced_at = now(), updated_at = now() WHERE id = 'singleton';`
2. Restart `artifacts/api-server: API Server` — kills the in-flight giant sync.
3. On the fresh start only a bounded 2-day backfill + a tiny (~30-min, few-dozen-participant) incremental run. The small incremental finishes in minutes and writes today's recent calls; the 2-day backfill fills in the rest of today over the following ~30-50 min.

**Why:** collapsing the cursor removes the multi-day incremental that saturates the rate limit and never commits. **Trade-off:** the gap days (between old cursor and now) won't be backfilled — acceptable when the user only needs today (dashboard filters are locked to today).

# Note
This is OpenPhone rate-limited; even the bounded backfill takes tens of minutes. There is no way to make a cold catch-up instant.
