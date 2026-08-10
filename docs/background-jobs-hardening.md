# Background jobs hardening baseline

Branch: `hardening/10-background-jobs`  
Base: tested `hardening/09-database-performance` at `5a1f27ef773a5067cf2589a86115e321c3477e83`

This phase changes execution ownership, not dashboard calculations. Existing Quo, PBX, onboarding, live-transfer, QA, attendance, export, and API response calculations remain in their existing functions. The new layer durably records when those functions must run and prevents more than one active lease for the same job type.

## Durable design

- `background_jobs` is an additive PostgreSQL queue. Each row has a unique idempotency key, status, priority, attempt count, maximum attempts, retry time, lease owner/expiry, sanitized failure code, and sanitized result summary.
- Claims use `FOR UPDATE SKIP LOCKED` plus a transaction-scoped PostgreSQL advisory lock for the job type. This prevents overlapping workers across Vercel instances while allowing unrelated job types to run concurrently.
- A worker owns a six-minute lease and has a four-minute application timeout. An expired lease is reclaimable after an instance exits. Timeout retries are delayed by at least one full lease so an aborting invocation cannot immediately overlap its replacement.
- `durable_runtime_state` stores cross-instance Quo live polling, verified webhook live-call state, and PBX cache snapshots. Process-local maps remain only as same-instance accelerators and are hydrated from PostgreSQL.
- Business writes remain idempotent: Quo calls use primary-key upserts, PBX missed calls and classifications use conflict-safe inserts, QA review selection remains idempotent, and the phase-6 webhook inbox still deduplicates provider events.
- No Redis or paid queue was introduced. PostgreSQL is already mandatory, so this is the least disruptive design and the additive tables can remain harmlessly in place if the application branch is rolled back.

## Schedule and serverless behavior

`GET /api/jobs/cron` is the single scheduler/worker entry point. It requires an exact `Authorization: Bearer <CRON_SECRET>` value; the configured secret must contain at least 16 characters and is compared with `timingSafeEqual`. It never logs the header or secret.

Each invocation idempotently schedules:

| Work | Idempotency bucket | Intended cadence | Retry limit |
| --- | --- | --- | --- |
| Quo live poll + PBX refresh | UTC minute | every minute | 4 |
| Quo incremental sync | UTC 15-minute window | every 15 minutes | 4 |
| Biweekly QA eligibility run | UTC day at 09:00 | daily check, existing per-agent 14-day rule | 3 |
| PBX historical backfill | UTC day at 09:00 | daily recovery pass | 3 |
| Weekly QA task assignment | UTC day, Monday at 09:00 | weekly | 3 |

The invocation claims at most one job so its four-minute worker timeout fits inside the configured five-minute function duration. Vercel does not retry failed cron HTTP invocations, so unclaimed and retryable rows remain in PostgreSQL for a later invocation. A Vercel function is capped at 300 seconds in `vercel.json`; work is not considered lost if that request is terminated because its lease expires and the next worker can reclaim it.

The minute schedule requires a Vercel Pro or Enterprise plan. Vercel Hobby accepts only daily cron schedules. Before any deployment, confirm the plan or configure an existing trusted scheduler to call the same authenticated endpoint every minute. Do not deploy the minute expression to Hobby because Vercel will reject it. No deployment was performed in this phase.

## Inventory and disposition

| Previous behavior | Risk | Phase-10 disposition |
| --- | --- | --- |
| Quo `setTimeout` 15-minute sync loop and startup fire-and-forget backfills | Restarts lose work; instances overlap | Replaced by `quo_sync` rows and leased workers; the same 90-day initial and overlapping incremental windows are retained. |
| Quo `setInterval` live poll and request-bound Vercel polling | Timer disappears; dashboard request waits on provider | Replaced by minute jobs and a durable live snapshot; `/quo/live` preserves its response shape and DB fallback. |
| Quo webhook live-call `Map` | Live state is instance-local | Retained as a latency cache and mirrored to expiring PostgreSQL state after verified durable webhook receipt. |
| PBX 30-second interval, fire-and-forget manual refresh, and process-local cumulative caches | Work and counters disappear on restart | Replaced by leased refresh jobs and a PostgreSQL snapshot containing call history, missed totals, callback items, mappings, and violation/attendance call spans. |
| PBX one-time 100-page fire-and-forget backfill | Often terminated after the response, repeated per instance | Replaced by a daily idempotent `vos_backfill` job and conflict-safe PBX inserts. |
| Onboarding `jobRunning` flag and `void runReport()` | Instance-local overlap control; response can outlive work | Replaced by a queued job, DB lease, durable progress table, retries, and server-side active-job status. Existing `{ started: true }` response is preserved. |
| Live-transfer `jobRunning` flag and `void runClassifier()` | Same | Replaced by the same durable pattern; existing success and conflict responses are preserved. |
| QA cron waits for an entire AI batch | Cron timeout loses scheduler ownership | Compatibility endpoint now enqueues only. The main cron queues the same QA logic; manual QA keeps its detailed synchronous response while executing through a durable leased row. |
| Webhook ingestion | Already durable from phase 6 | Kept unchanged; completed-call upserts and provider-event uniqueness continue to prevent duplicate KPIs. |
| Authentication sessions and rate limits | Potential process-local state | Already PostgreSQL-backed in prior phases; no change. |
| ReadyMode and PBX login cookies | Module-local | Retained only as disposable upstream authentication caches. They contain no authoritative business state and are safely reacquired after restart. |
| Sheets title cache, webhook line/user cache, blocklist cache | Module-local lookup optimization | Retained because their authoritative source is external or PostgreSQL and a cache miss reloads it; no queued business write depends on them. |
| Retry/abort `setTimeout` calls | Per-request timers | Retained intentionally for bounded provider backoff and request cancellation, not scheduling. |
| Excel downloads, Samia chat, single-call QA, imports, attendance writes | Request-bound user actions | Retained because the caller needs the response/file/result and these do not start work after the response. |
| Startup admin/member seed operations | Awaited startup database writes | Retained; they are not process-local background work. |

## Compatibility

- Manual Quo sync still returns `{ success, message, from, to }`.
- Manual PBX refresh still returns `{ ok: true }`.
- Onboarding and live-transfer refresh endpoints still return `{ started: true }`, and their existing status endpoints still expose `running`, progress, totals, and last-run data.
- QA admin processing still returns the existing detailed run result after success.
- Dashboard KPI queries and formulas were not changed. Retry tests write the same sanitized call ID repeatedly and prove total, connected, and missed KPIs remain `1`, `1`, and `0` rather than duplicating.
- Webhook processing remains raw-body verified and idempotent; middleware ordering was not changed.

## Operations and rollback

Before a future deployment, apply migration `0009_background_jobs.sql`, configure a random `CRON_SECRET` of at least 16 characters, confirm minute-cron support, and monitor failed/retry rows. Administrators can list sanitized job state with `GET /api/jobs?status=failed` and inspect a specific row at `GET /api/jobs/:id`.

To roll back application execution, redeploy the previously tested application commit and restore the earlier cron entry. The two additive tables do not modify or replace business tables and need not be dropped. Dropping them should be a separate reviewed cleanup only after no phase-10 code is running.

## Local verification notes

- The phase-10 migration was applied successfully to an isolated PostgreSQL 16 database.
- Real PostgreSQL tests covered duplicate enqueue, concurrent claims, lease expiry/restart recovery, completion results, and durable runtime snapshots.
- The repository's full clean migration chain has a pre-existing failure in `0003_anthropic_controls.sql`: it alters `qa_reviews` before that table exists in the phase-0 clean schema. This predates phase 10; `0009` itself applies successfully and was tested separately.
- Live provider workflows require configured sanitized/non-production Quo, PBX, Anthropic, and dashboard credentials. They were not invoked against production by this phase.

References: [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Vercel cron usage and plan limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), and [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration).
