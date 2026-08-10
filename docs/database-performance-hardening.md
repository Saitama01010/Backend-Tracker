# Database performance hardening baseline

Branch: `hardening/09-database-performance`

Base: `hardening/08-platform-controls` at `74a6713c771523b186f28cbb2d109fbd94f58869`

This phase changes query execution and database access patterns only. It does not change KPI definitions, response schemas, authorization, team mappings, agent aliases, pagination, timezone rules, or date boundaries. No production database or customer data was used.

## Query inventory and decisions

| Area | Existing query behavior | Frequency / cost signal | Phase-9 decision |
| --- | --- | --- | --- |
| `GET /api/quo/stats` | Reads calls for the requested range and applies authorization, canonical agent aliases, blocklists, teams, LA dates, and KPI formulas in Node.js. | Main dashboard refresh; result volume grows with the range. | Retain calculations. Add the missing general `created_at` index only. Moving this aggregation without reproducing every mapping would risk KPI drift. |
| `GET /api/quo/line-stats` | Reads per-line calls and calculates daily/agent KPIs in Node.js. | Dashboard chart refresh. | Retain calculations and the existing `(line_id, created_at)` index. |
| `GET /api/quo/calls` | Authorizes and filters the complete range before pagination. | Call table and exports. | Retain order of authorization, filtering, and pagination. Pushing the limit earlier would change visible rows. |
| `GET /api/quo/live` | Filters `status = 'in-progress'` by recent `synced_at`. | Polling endpoint. | Add a small partial live-call index. |
| `GET /api/attendance/call-logs` and `POST /api/attendance/auto-mark` | Transfers every qualifying call for the LA day, normalizes raw names in JavaScript, and then finds the earliest call. | One row per call rather than one row per raw agent name. | Aggregate `min(created_at)` per raw agent name in parameterized SQL; preserve JavaScript normalization and aliases. |
| `POST /api/attendance/set` | Loads the active-member directory during authorization and again per record; reads, upserts, and verifies each record separately. | N+1 behavior proportional to batch size. | Load members once and execute one transactional existing-record read, one bulk upsert, and one bulk verification read. Preserve sequential duplicate/conflict actions in the planner. |
| `POST /api/attendance/auto-mark` | Inserts each derived attendance record separately. | N writes for N marked members. | Keep all status and late-minute calculations intact; issue one conflict-safe bulk insert. |
| `POST /api/attendance/import` | Looks up or inserts each member, then inserts every populated date cell separately. | N+1 member reads plus one write per populated cell. | Parse every source first, then use one transaction, a member-directory read, a bulk member insert, and 500-row conflict-safe record chunks. Preserve attempted-record and new-member totals. |
| `POST /api/qa/assign-weekly` | Reads two task sets per agent and inserts each selected call separately. | `1 + 2N + up to 2N` statements. | Read relevant tasks once, run the same seeded-testable selection logic, and perform one conflict-safe bulk insert. |
| `GET /api/qa/stats` and downloads | Applies department and final agent authorization before totals and exports. | Potentially large but authorization-sensitive. | Retain existing calculation and filtering behavior. Existing date and department indexes remain applicable. |
| Missed-call, violations, and PBX reports | Repeated date, line, status, participant, and source-number lookups. | Dashboard refreshes and downloads. | Add targeted partial/composite indexes; do not rewrite report formulas. |
| Samia phone history | Looks up an exact normalized participant/source number and recent records. | User-triggered, bounded to 50 returned rows. | Add participant/from-number plus descending date indexes. |

The inventory found 149 database-query or raw-SQL call sites across the API route layer. Only the equivalence-proven paths above were rewritten. Complex Quo, QA-statistics, violation, and PBX aggregations remain on their prior implementation.

## Index migration

Migration `lib/db/drizzle/0008_database_performance.sql` is idempotent and adds:

| Index | Justification |
| --- | --- |
| `phone_calls_created_at_idx` | General Quo/dashboard date-range scans lacked a leading date index. |
| `phone_calls_attendance_created_agent_idx` | Partial covering key for the exact outbound-or-completed-inbound attendance predicate. |
| `phone_calls_participant_created_idx` | Exact participant history ordered by newest call. |
| `phone_calls_missed_line_created_idx` | Partial key for inbound missed statuses filtered by line and date. |
| `phone_calls_live_synced_idx` | Small partial key for recent in-progress polling. |
| `pbx_missed_from_created_idx` | PBX source/from-number history ordered by newest record. |
| `attendance_records_date_member_idx` | Date-first reads; the existing unique key is ordered `(member_id, date)`. |

Existing `(line_id, created_at)`, `(agent_id, created_at)`, `(line_team, created_at)`, PBX date/team, QA, and manager-task indexes were retained. No new index duplicates those key orders. Applying the migration twice in the isolated database produced exactly one definition for every new index.

## Equality and performance evidence

The opt-in integration test used PostgreSQL 16 in a temporary local Docker container with no host volume. Fixtures contained synthetic names and identifiers only. The database and container were removed after the run.

| Optimized endpoint/path | Dataset | Old result | New result | Equality | Old time | New time |
| --- | ---: | --- | --- | --- | ---: | ---: |
| Attendance first-call lookup used by call logs and auto-mark | 180,000 calls, one fixed UTC window corresponding to the same requested calendar range | 120 agents, digest `b9621377b60810ae`, 1,386 rows transferred | 120 agents, digest `b9621377b60810ae`, 120 rows transferred | Exact | 10.90 ms | 3.26 ms |
| Weekly QA assignment | 12,000 reviews, 100 agents, 110 existing tasks | 100 agents, 180 picks, digest `0e83f08cca5cc5ad` | 100 agents, 180 picks, digest `0e83f08cca5cc5ad` | Exact | 390.47 ms, 371 statements | 38.01 ms, 3 statements |
| Attendance batch conflict/write semantics | 80 members; unchanged, conflict, create, duplicate, and missing cases | `unchanged, conflict, created, unchanged, member_missing` | Same actions; final record count 3 | Exact | Record-at-a-time writes | One bulk write inside a transaction |
| Attendance import | 100 imported members, 20 pre-existing, 1,400 populated date cells | 80 new members, 1,400 attempted records, 1,400 persisted | Same totals and persisted count | Exact | 1,411.10 ms, 1,581 statements | 155.47 ms, 6 statements |

Timings are local single-run measurements and are evidence for this fixture, not production latency promises. The attendance timing includes query result transfer and JavaScript reduction; PostgreSQL's measured execution portion was 0.384 ms old and 0.430 ms new, while the optimized query reduced transferred rows by 91.3%. Weekly QA and attendance-import timings include reads, selection/planning, and conflict-safe writes.

`EXPLAIN (ANALYZE, FORMAT JSON)` confirmed:

- Attendance aggregation: bitmap index scan on `phone_calls_attendance_created_agent_idx`.
- Exact participant history: bitmap index scan on `phone_calls_participant_created_idx`.
- Missed-line history: bitmap index scan on `phone_calls_missed_line_created_idx`.
- Live-call polling: bitmap index scan on `phone_calls_live_synced_idx`.
- PBX source history: bitmap index scan on `pbx_missed_from_created_idx`.
- The 110-row QA task fixture correctly chose a sequential scan for the all-agent bulk read; this is cheaper at that tiny table size and does not make the existing agent index unused for selective reads.
- The three-row attendance fixture correctly chose a sequential scan; the date-first index exists for realistic multi-date tables.

## Compatibility controls

- Attendance continues to use `America/Los_Angeles`, the same inclusive `>= dayStart` and `<= nextDay - 1 ms` bounds, the same VoS/Quo choice, and the same member aliases.
- SQL groups by the raw agent string. Trimming and case normalization remain in JavaScript, so PostgreSQL collation cannot change identity matching.
- Weekly QA retains review order for tied low scores, calls `Math.random` at the same decision points, skips current-week assignments, and excludes all existing task IDs.
- Attendance batch planning is sequential even though persistence is bulk, preserving duplicate-input and `force` conflict outcomes.
- The existing maximum ranges remain unchanged: integration reads 1,096 days, Quo sync 31 days, and explicitly ranged PBX missed-call reporting 90 days. Attendance queries remain a single LA calendar day. No compatible request was newly rejected.
- Authorization still resolves before data is returned, and private exports still use their existing filters and response shapes.

## Pool review

The application still creates one shared `pg.Pool`. Phase 9 makes the existing node-postgres defaults explicit (`max=10`, `idleTimeoutMillis=10000`) and adds a finite 10-second connection timeout. Deployments behind a database pooler can lower the bounded `DB_POOL_MAX` without code changes. No prepared-statement names, connection pinning, or new database architecture were introduced, so transaction-pooler compatibility is unchanged.

Supported environment overrides:

- `DB_POOL_MAX` (1-50)
- `DB_POOL_IDLE_TIMEOUT_MS` (1,000-300,000)
- `DB_POOL_CONNECTION_TIMEOUT_MS` (1,000-120,000)

Invalid or out-of-range overrides fall back to the documented defaults.

## Verification commands

Pre-change baseline on the phase-8 commit:

```text
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:security
pnpm run test
pnpm run test:baseline
pnpm run test:smoke
pnpm run build
```

Phase-9 focused verification:

```text
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run test
PERFORMANCE_DATABASE_URL=<guarded-local-test-url> DATABASE_URL=<same-url> pnpm run test:performance
```

The performance test refuses non-local hosts and database names that do not contain `test` or `performance`.

## Final verification results

| Check | Before changes | After changes |
| --- | --- | --- |
| `pnpm run typecheck` | Pass | Pass |
| `pnpm run test` | 57 passed | 60 passed |
| `pnpm run test:baseline` | 5 passed | 5 passed |
| `pnpm run test:security` | Frontend 7 passed; backend 71 passed, 1 database integration skipped | Same |
| `pnpm run test:performance` | Not present | 1 passed against isolated PostgreSQL 16 |
| `pnpm run test:smoke` | 1 skipped because no live smoke database/password was configured | Same |
| `pnpm run build` | Pass with existing Vite sourcemap and large-chunk warnings | Same warnings; pass |

The production build was also started against a separate ephemeral local PostgreSQL database created from the repository schema with background integrations disabled. Verification returned:

- `GET /api/healthz`: `200`, `{ "status": "ok" }`
- Local sanitized admin login: success with role `admin`
- Authenticated `GET /api/quo/stats`: existing fields `teamStats`, `allAgentStats`, `lineInbound`, `agentLastCall`, `allAgentLastCall`, `totalRows`, `lastSyncedAt`, `isSyncing`
- Dashboard HTML root: `200`, `text/html`

No phase-9 listener, test container, or test database remains. Live chart rendering, downloads, and external Quo/PBX/ReadyMode/Sheets values were not retested because this worktree was not given a live smoke database, account, or approved provider credentials. Those remain covered by the unchanged baseline contracts rather than a new live-data claim.

No pre-existing check failed. No new check failed. The only skipped checks are the same environment-gated live smoke test and database-backed webhook integration test recorded before modifications.
