---
name: OpenPhone sync scoping & startup contention
description: Why a "single line" OpenPhone sync is still partly expensive, and the restart rate-limit collision to watch for.
---

# OpenPhone sync scoping

The OpenPhone `/conversations` endpoint cannot be filtered by phone line — it
returns the whole workspace's conversations for the time window. So even when a
sync is scoped to one line, step 1 (paging conversations to collect participants)
still pages everything; only step 3 (per-participant call fetch) shrinks.

**Why:** scoping `runSync` to a single line (e.g. the onboarding report refresh)
makes it *much* cheaper on the call-fetch fan-out but does NOT avoid the
conversation paging cost — that floor is inherent to the API.

**How to apply:** don't expect a single-line refresh to be instant; budget for the
full conversation page walk. To scope, restrict the line set passed into the
conversation collector + call-fetch task builder; skip writing global
`phone_sync_state` for scoped runs.

## Startup backfill vs manual refresh collision
On server boot the background sync kicks off a multi-day, all-lines backfill. If a
manual line-scoped refresh is triggered right after a restart, both hammer
OpenPhone at once and the shared rate limit (429s) starves both — a scoped refresh
that normally takes a couple minutes can take 10+. This is a restart artifact, not
a bug; in steady state (server already up) a manual refresh runs without that
contention.

## Background-job running flag must come from the in-process flag
For a singleton background job whose `isRunning` is mirrored to the DB, derive the
API's `running` field from the in-memory flag, not the DB row. A crash/restart
mid-job leaves the DB `isRunning=true` forever, which would otherwise pin a polling
UI in a permanent "running" state. Also keep the initial `isRunning=true` write and
the in-memory `jobRunning=true` inside the same `try/finally` so a failed startup
write can never deadlock future runs.
