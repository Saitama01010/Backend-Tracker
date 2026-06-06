---
name: Live transfers classification
description: How inbound partner + internal warm-transfer calls are classified in the agent-dashboard live-transfers report.
---

# Live transfers (partner + internal) classification

The live-transfers report classifies inbound warm-transfer calls of two kinds: PARTNER (external rep from Aspire / Resync / Clarity / Concordia hands off a client) and INTERNAL (one of our own departments — CS, NSF, Onboarding, Retention, Billing, etc. — transfers the client in). Scope (receiving line) is unchanged: incoming + completed + duration >= MIN_SECONDS, on the onboarding line or retention/cs team lines. The internal SOURCE department can be any team.

**Data model:** `live_transfer_classifications.kind` is `"partner" | "internal" | null`. For partner, `company` holds the company name; for internal, `company` holds the normalized department (canonicalized by `normalizeDept()` so casing/wording variants like "Account services" vs "Account Services" don't split into separate buckets). `isLive = kind is partner or internal`.

**Rule:** keyword/intent match is ONLY a cheap recall pre-filter to decide whether to call the AI. The AI's returned `kind` is the precision gate that sets `isLive`. Never mark `isLive=true` from a keyword hit alone.
- Partner names (`aspire`/`re-?sync`/`clarity`/`concordia`) gate the AI for partner candidates.
- A broad `TRANSFER_INTENT_RE` (transfer / hand over / "I have a client" / department names / etc.) is REQUIRED to catch internal transfers, since they contain no partner keyword. Broadening the pre-filter is what makes internal detection possible — but it multiplies AI calls (~thousands over the candidate set), so the initial rebuild churns for many minutes at CONCURRENCY=4.

**Why:** keyword-only classification produced ~2x false positives — the company name often appears in passing, or the client (not a rep) is the caller. The AI judges the call opening to confirm an actual handoff.

**How to apply:** if the AI extract fails (returns null), leave the row unclassified so the next background run retries — do not fall back to keyword-only. Classifications are deduped via `onConflictDoNothing` and the background job only processes calls with NO existing row, so any change to the prompt, pre-filter, kind/department logic, or schema requires a one-time backfill: `DELETE FROM live_transfer_classifications` + reset `live_transfer_state` (is_running=false, progress 0), then restart api-server (auto-kicks the classifier) or POST `/api/live-transfers/refresh`. Without the delete, old cached rows keep their stale classification and historical ranges undercount.

**Status flag:** the `/status` endpoint reports `running` from the in-memory `jobRunning` flag, not the DB `is_running` column (a crash can leave the DB flag stale). Same convention as OpenPhone sync. Invariant: `partnerTotal + internalTotal == totalLive`.
