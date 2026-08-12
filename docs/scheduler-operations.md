# Scheduler operations contract

`config/scheduler-contract.json` is the machine-readable scheduling source of
truth. `backgroundSchedule.ts` consumes it and the regression suite requires
`vercel.json` to match its native cron path and schedule.

The checked-in Vercel cron is a **daily 09:00 UTC recovery and housekeeping
invocation**. It is not evidence that one-minute or fifteen-minute processing
is active. Vercel Preview deployments do not execute Production cron.

## Task matrix

| Job                        |                     Intended cadence | Maximum delay | Catch-up                                                                                                                      | Idempotency and concurrency                                                                          | Executor                             |
| -------------------------- | -----------------------------------: | ------------: | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `integration_live_refresh` |                             1 minute |     2 minutes | Latest UTC-minute bucket only; stale live state is superseded                                                                 | `schedule:integration_live_refresh:<UTC-minute>` plus one active lease per job type                  | Authenticated `GET /api/jobs/cron`   |
| `quo_sync`                 |                           15 minutes |    30 minutes | The existing provider-window overlap catches up missed calls without duplicating rows                                         | `schedule:quo_sync:<UTC-quarter-hour>`, unique DB index, leased worker and conflict-safe call writes | Same endpoint                        |
| `qa_biweekly`              | Daily eligibility check at 09:00 UTC |       3 hours | Next authenticated 09:00 invocation; the downstream database reservation still enforces one run per agent per rolling 14 days | UTC-day key, job lease, QA advisory lock and durable AI reservation                                  | Same endpoint                        |
| `vos_backfill`             |                   Daily at 09:00 UTC |       3 hours | Next authenticated 09:00 invocation                                                                                           | UTC-day key, job lease and VoS database lease                                                        | Same endpoint                        |
| `qa_weekly_assignment`     |                  Monday at 09:00 UTC |      24 hours | Next Monday window; operators may use the existing authorized manual workflow when approved                                   | UTC-day key and job lease                                                                            | Same endpoint                        |
| `ai_reservation_cleanup`   |                   Daily at 09:00 UTC |       3 hours | Next authenticated 09:00 invocation                                                                                           | UTC-day key, job lease and `FOR UPDATE SKIP LOCKED` batches                                          | Same endpoint; never calls Anthropic |

The endpoint accepts only an exact `Authorization: Bearer <CRON_SECRET>` value
whose configured secret is at least 16 characters. Query parameters and an
ordinary browser JWT are rejected. The HTTP logger never records the header.
Each invocation claims at most one durable job; failed jobs retain a sanitized
failure code and stop at their `max_attempts` value.

Administrators can call `GET /api/jobs/scheduler-health` to see the last
authenticated invocation and whether the high-frequency maximum delay has
been exceeded. The response contains timestamps and counts only.

## High-frequency scheduler decision matrix

| Option                                   | Supported cadence                                                                 | Infrastructure and cost category                                        | Authentication/retry                                                                                                   | Observability and complexity                                                        | Failure modes                                                  | Recommended use                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Vercel plan with required cron frequency | Native one-minute and fifteen-minute schedules if the selected plan supports them | Existing platform, higher paid plan category                            | Vercel sends the bearer secret; Vercel delivery is not a durable retry queue, while PostgreSQL jobs remain retryable   | Lowest operational complexity; Vercel logs plus scheduler health and job tables     | Missed invocation, duplicate delivery, platform limit change   | Preferred when consolidating operations in Vercel is worth the plan change                 |
| External authenticated scheduler         | One minute, fifteen minutes and 09:00 UTC                                         | Separate scheduler; free or paid category depends on operator selection | Store a staging/Production-specific bearer secret; bounded HTTP retries with jitter; never place the secret in the URL | Additional service and alerting; endpoint and DB job observability remain unchanged | Secret expiry, scheduler outage, retry storm, incorrect target | Preferred when an approved scheduler already exists or a Vercel plan change is undesirable |
| Formally reduced product cadence         | Daily native invocation only                                                      | No new infrastructure or spend                                          | Existing Vercel bearer delivery                                                                                        | Simple, but live refresh and Quo sync become daily                                  | Stale live state and delayed dashboard calls                   | Only after explicit product-owner acceptance of reduced behavior                           |

No option is activated by this repository change. Before selecting either
high-frequency option, use a staging-only secret and isolated database, invoke
the endpoint concurrently, confirm unique job rows, and alert when
`highFrequencyStale` becomes true.
