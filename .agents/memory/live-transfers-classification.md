---
name: Live transfers classification
description: How inbound Aspire/Resync warm-transfer calls are classified in the agent-dashboard live-transfers report.
---

# Live transfers (Aspire/Resync) classification

The live-transfers report classifies inbound partner warm-transfer calls. Scope: incoming + completed + duration >= MIN_SECONDS, on the onboarding line or retention/cs team lines.

**Rule:** a transcript keyword match (`aspire` / `re-?sync`) is ONLY a cheap pre-filter to decide whether to call the AI. The AI's `isTransfer` boolean is what sets `isLive`. Never mark `isLive=true` from keyword presence alone.

**Why:** keyword-only classification produced ~2x false positives (53 "live" per 100 calls vs ~11 per 150 with AI gating) — the company name often appears in passing, or the client (not a partner rep) is the caller. The AI judges the call opening to confirm an actual rep-to-us handoff.

**How to apply:** if the AI extract fails (returns null), leave the row unclassified so the next background run retries — do not fall back to keyword-only. Classifications are deduped via `onConflictDoNothing`, so to re-apply changed classification logic you must DELETE existing `live_transfer_classifications` rows; the background job only processes calls with no existing row.

**Status flag:** the `/status` endpoint reports `running` from the in-memory `jobRunning` flag, not the DB `is_running` column (a crash can leave the DB flag stale). Same convention as OpenPhone sync.
