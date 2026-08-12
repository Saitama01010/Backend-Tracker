# Dashboard runtime optimization

## Scope and fixed baseline

- Starting `origin/main`: `edfe8a3f4684b21aec7976ad900b37175cdd9f25`
- Starting Vercel Production deployment: `admindashboard-85ikjzul2-backend-tracker.vercel.app`
- Starting Production SHA: `edfe8a3f4684b21aec7976ad900b37175cdd9f25`
- Branch: `perf/dashboard-runtime-optimization`
- Fixed historical browser range: 2026-07-01 through 2026-07-31, America/Los_Angeles boundaries
- Production role: administrator, no team or agent filter
- Production database state before this branch: PostgreSQL 16.14, 13 ledger rows through migration `0011`

The seven commits after the previous release were reviewed before implementation. This branch preserves the corrected Quo participant parameter, provider throttle and 429 retry behavior, durable 45-second live-poll lease/cache, terminal-call persistence, live-agent-before-metrics behavior, visible Quo failures, and the narrow PBX-banner removal.

## Data-flow inventory

Only the active Radix tab is mounted. Query keys shared across panels are deduplicated by React Query; the table below records the active Retention path plus the on-demand paths used by other dashboard tabs.

| UI consumer | Query key | Endpoint | Initial/poll behavior | Backend/data source | Boundaries |
| --- | --- | --- | --- | --- | --- |
| Authentication shell | session validation | `GET /api/auth/me` | once on authenticated startup | `portal_users`, `auth_sessions` | current user/session |
| Roster provider | `roster` | `GET /api/team-agents` | initial, 30 s visible polling | `team_agents` | server authorization, active/inactive contract |
| Retention/CS/NSF cards and By-call table | `phoneStats,from,to` | `GET /api/quo/stats` | initial, 5 min visible polling | `phone_calls`, `blocked_numbers`, `phone_sync_state` | date, status, user/team/agent authorization before aggregation |
| ReadyMode merge | `readymodeStats,from,to` | `GET /api/readymode/stats` | initial, 60 s active / 120 s idle | ReadyMode upload/provider path | bounded date range |
| Sheet-backed file metrics | `sheet-source,scope,id,gid` | `GET /api/sheet?...&format=rows-v1` | four independent sources in parallel; 5 min polling | approved Google Sheets tabs | source allowlist and per-user row scope before serialization |
| Current Quo state | `liveCalls` | `GET /api/quo/live` | 5 s while visible; immediate focus refresh | durable webhook/poll state plus recent partial-index DB fallback | per-user team/agent authorization |
| Quo source refresh | `liveCallsRefresh` | `GET /api/quo/live/refresh` | 45 s while visible | coalesced OpenPhone provider scan | durable lease, 90 s timeout, two-way concurrency |
| PBX current state | `vosLive` | `GET /api/vos/live` | shared key, 15 s | VoS/PBX | existing failure semantics retained |
| PBX totals | `vosStats` | `GET /api/vos/stats` | 60 s | VoS/PBX | existing scope retained |
| Call-detail subtab | `calls,team,from,to` | `GET /api/quo/calls?...&limit=500` | mounted only for By-call detail | `phone_calls` | validated dates, authorization, deterministic order, max 1,000 rows |
| Line detail | `lineStats,line,from,to` | `GET /api/quo/line-stats` | Phones view only | `phone_calls` | selected line and date range |
| Missed/no-callback views | `missedNoCB`, `missedDaily`, `missedHourly` | `/api/vos/missed-*` | only when tab mounted; 30 s to 5 min | PBX plus call records | server policy and bounded dates |
| QA, violations, onboarding, attendance | tab-specific keys | `/api/qa/*`, `/api/violations*`, `/api/onboarding/*`, `/api/attendance*` | only when their tab/view is mounted | bounded SQL/provider services | existing role, team, date, and pagination policy |

The measured initial waterfall was the four Sheet downloads plus ReadyMode, Quo stats, roster, auth, and live/PBX state. The largest repeat cost was 9.20 MB of decoded Sheet JSON per refresh. The slowest call calculation loaded 49,023 historical rows into Node to build summary cards.

## Root causes and implemented changes

1. `GET /api/quo/stats` selected every matching call row, transferred it to Node, then repeated team, agent, daily, unique-contact, line, and last-call aggregation in JavaScript. It now resolves the small source-dimension/authorization map first and performs bounded grouped aggregation in PostgreSQL. A 15-second, 50-entry administrator cache is keyed by user, role, team, allowed tabs/agents, today lock, and exact date range. Non-admin requests bypass the response cache so a mutable directory reassignment takes effect immediately.
2. Sheet responses repeated every header name in every row. The default response remains unchanged; the dashboard opts in to `rows-v1`, which sends columns once and row arrays, reconstructing the exact legacy objects in the browser. The server caches unscoped source snapshots for 60 seconds, coalesces concurrent refreshes, parses once, applies authorization on every response, supports stable ETags, and serves a visibly marked result for no longer than five minutes after refresh failure.
3. `GET /api/quo/live` previously blocked on a provider conversation/call scan. It now reads only durable webhook/poll state and the partial live-state index. A separate coalesced refresh retains all previous provider throttle, retry, lease, timeout, participant, and terminal persistence behavior. Completion tombstones prevent an older poll/DB row from resurrecting a call that just ended.
4. The frontend now requests the compact Sheet format, starts the four independent Sheet sources in parallel, preserves previous data during refresh, shows stale/last-successful state, and polls only the lightweight live endpoint at five seconds. Polling pauses while hidden and React Query refetches on visibility/focus return. Existing heavy tabs remain lazy/on-demand and large tables retain their bounded pagination/content-visibility behavior.

## Measured evidence before merge

### Production baseline

Five cold and ten warm authenticated Production loads were captured in Chrome on the starting SHA.

| Metric | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| First meaningful number | 705 / 900 ms | 833 / 1,162 ms |
| First usable table | 705 / 900 ms | 833 / 1,162 ms |
| Main dashboard interactable | 705 / 900 ms | 833 / 1,162 ms |
| Requests | 14 / not recorded | 16 / 16 |
| API requests | 8 / not recorded | 9 / 9 |
| Transferred bytes | 747,882 / not recorded | 748,075 / 748,306 |
| JavaScript execution | 526 / 602 ms | 466 / 547 ms |
| CDP task duration | 4,873 / 5,112 ms (n=4) | 5,253 / 6,473 ms |
| JS heap | 54.05 / 68.89 MB | 58.11 / 87.17 MB |

Important initial endpoint timing samples on the starting deployment:

| Endpoint | n | p50 | p95 | Payload evidence |
| --- | ---: | ---: | ---: | --- |
| `/api/quo/live` | 13 | 270.6 ms | 4,010.3 ms | healthy cache responses were about 0.6-0.8 KB transferred; provider-blocked responses reached 22.7 s in the long-lived trace |
| `/api/quo/live` application log | 30 | 84 ms | 4,776 ms | latest 30 completed `quo live` observations after prior warm traffic; no errors |
| `/api/sheet` (per source) | 60 | 960.0 ms | 1,812.1 ms | p50 141,484 B and p95 368,526 B transferred; p50 1,765,325 B and p95 4,595,642 B decoded |
| `/api/readymode/stats` | 14 | 744.4 ms | 3,243.3 ms | 1,944 B decoded in the fixed-July trace |
| `/api/team-agents` | 15 | 268.0 ms | 363.8 ms | 8,581 B decoded |
| `/api/auth/me` | 15 | 261.8 ms | 366.9 ms | small JSON |

For the fixed July range, five warm-ups preceded 30 measured browser `/api/quo/stats` requests. They had a 5.359-second p50, 7.479-second p95, 5.038-second minimum, and 7.487-second maximum, with no errors. Each response transferred 34,840 bytes, decoded to 410,032 bytes, and produced the visible total of 8,773 calls.

Twenty read-only interactions covered agent searches, table sorting, By call/By files/By day switches, agent filtering, and dashboard-panel switches. End-to-settle latency was 1,161 ms p50 / 3,822 ms p95, with a 5,290 ms maximum. During a 7.24-minute normal-use observation the long-task observer captured 68 tasks over 50 ms, 53 over 200 ms, and a 6,370 ms maximum; JS heap moved from 37,001,300 to 44,549,414 bytes (+7,548,114 bytes). These are starting-deployment measurements and use the same instrumented browser tab that performed the interactions.

### Exact Production-data handler comparison

These read-only comparisons ran the legacy and optimized handlers against the same Production snapshot and normalized their JSON before hashing.

| Authorization scope | Legacy | Optimized | Difference | Source rows | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Admin, fixed July | 9.602 s | 1.694 s | -82.4% | 49,023 | exact digest match |
| Retention team, fixed July | 4.108 s | 1.007 s | -75.5% | 10,126 | exact digest match |
| Allowed-agent fixture | 3.375 s | 0.455 s | -86.5% | 0 | exact digest match |

The optimized admin response used 2,896 aggregate rows instead of materializing 49,023 call rows. A representative miss reported about 1,660 ms database, 6.8 ms transform, and 2 ms serialization time. Cache hits are below one millisecond inside the handler.

### PostgreSQL 16 query-plan comparison

The disposable database contained 220,000 sanitized call rows. Five warmed matched runs were collected after discarding one warm-up in each mode.

| Metric | Sequential plan | Covering-index plan | Difference |
| --- | ---: | ---: | ---: |
| Execution p50 | 32.889 ms | 15.950 ms | -51.5% |
| Execution p95 | 37.520 ms | 17.625 ms | -53.0% |
| Rows examined | 220,000 | 79,951 | -63.7% |
| Shared blocks | 4,985 | 1,502 | -69.9% |
| Plan | Seq Scan | Index Only Scan | heap fetches: 0 |

The exact legacy and SQL aggregate digests both equal `1a3c4368d47afe5d` across 79,951 fixed-range source rows. The aggregate query returned 7,118 grouped rows.

### Twenty-client read load

The isolated PostgreSQL 16 load database contained 220,000 calls and 120 agents. Five warm-ups preceded 60 measured requests per endpoint, sent in waves of 20 concurrent clients.

| Endpoint | n | min | p50 | p95 | max | p50 body | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/quo/stats` scoped-cache hit | 60 | 200.88 ms | 220.02 ms | 240.82 ms | 245.07 ms | 1,051,639 B | 0 |
| `/api/quo/live` | 60 | 101.37 ms | 222.45 ms | 293.48 ms | 293.60 ms | 11,653 B | 0 |

All 60 stats requests were scoped cache hits. Database sessions rose from 5 to the configured pool ceiling of 10 without errors or connection exhaustion. The first cold stats request completed in 962 ms. A representative live response reported 29.39 ms database time and 34.17 ms application time.

### Five-second live-state acceptance

Ten start and ten end offsets spanning a five-second polling period were tested. Start p50/p95 and end p50/p95 were all at or below five seconds; the maximum synthetic display delay was below five seconds. Separate tests prove visible stale state after 45 seconds, expiry after two minutes, hidden-tab pause, visibility-return refetch, and suppression of older poll/DB observations after a terminal webhook.

## Index and Production procedure

Index definition:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "phone_calls_dashboard_stats_cover_idx"
ON "phone_calls" USING btree ("created_at")
INCLUDE (
  "agent_name", "line_name", "line_team", "line_id", "participant",
  "direction", "status", "duration_seconds", "post_answer_seconds"
)
WHERE "status" <> 'in-progress';
```

- Supported query: bounded non-live `/api/quo/stats` dimension and aggregate scans.
- Disposable size: 33,660,928 bytes (32 MB) for 220,000 calls.
- Overlap: the existing `phone_calls_created_at_idx` supplies only the date key and still supports queries not constrained by the partial predicate; no existing index covers the selected aggregate columns.
- Write cost: one additional partial B-tree entry for every inserted or updated non-live call, plus included-column maintenance. Live `in-progress` writes are excluded until terminal persistence. Production has roughly 190,000 calls, so storage is expected to be on the order of the measured 32 MB, verified immediately after creation.
- Query rewriting alone removes Node materialization, but the covering index is needed to avoid visiting the full heap for each bounded aggregate scan.

Before merge, use a verified recoverable database snapshot, confirm no long transaction, then run outside a transaction:

```powershell
$env:ONLINE_INDEX_ACK='APPLY_DASHBOARD_PERFORMANCE_INDEX'
$env:DATABASE_URL='<production connection supplied securely>'
pnpm --filter @workspace/db run apply:dashboard-performance-index
```

The command takes an advisory lock, rejects long-running transactions and invalid/same-name definitions, applies a 5-second lock timeout and 20-minute statement timeout, creates concurrently, and prints validity, readiness, size, and duration. Verify independently:

```sql
SELECT indexrelid::regclass, indisvalid, indisready, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_index
WHERE indexrelid = 'phone_calls_dashboard_stats_cover_idx'::regclass;
```

Migration `0012` is additive. After the concurrent index exists, its `CREATE INDEX IF NOT EXISTS` is an idempotent ledgered no-op. The application does not run migrations during build/startup.

Rollback is manual and only for an index-caused regression:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f docs/sql/0012_dashboard_runtime_performance.rollback.sql
```

Leave the index in place during an application-only Vercel rollback.

## Correctness and verification

- Locked dependency installation: pass
- TypeScript and lint: pass
- Unit/API: 87/87 pass
- Baseline regression: 5/5 pass
- Frontend security/Sheet parsing: 13/13 pass
- API security: 99 pass, 7 environment-gated integration tests; every gated test was also run separately and passed
- Frontend performance: 10/10 pass
- Data correctness: pass, including attendance integration runs
- Query equivalence: exact old/new digest match on Production and on 79,951 sanitized rows
- Clean migration through `0012`: pass, 13 ledger rows, 44/44 schema-contract objects
- Online index absent-to-valid and idempotent runs: pass
- Production build and frontend bundle: pass; 895,156 B raw / 260,642 B gzip entry
- Dependency audit: no high or critical advisories
- Secret scan and GitHub checks: recorded in the PR/final deployment evidence

## Limitations

- The starting Production bundle did not expose the React DevTools profiling hook, so a true before render count is unavailable and is not replaced with an estimate.
- PostgreSQL does not expose host CPU through SQL; the load test records connections, active time, latency, cache hits, and errors. No historical peak-concurrency telemetry was available, so 20 simultaneous clients was selected as the safely practical stress level.
- Live provider refresh remains subject to OpenPhone latency and rate limits; the five-second UI path reports durable state already available to the application and reports provider refresh separately.
