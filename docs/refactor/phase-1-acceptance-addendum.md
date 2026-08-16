# Phase 1 acceptance addendum

Acceptance hardening was performed against Phase 1 commit `af8969fa0144edefff23bebb904fb78bbdd95357` in the isolated `refactor/phase-1-behavior-lock` worktree. Phase 2 was not started. All provider and database evidence below is sanitized and local; no Production system was load-tested and no live response body or credential was committed.

## Commit-diff audit

The literal requested `main...af8969f` audit exposed local-reference drift rather than a Phase 1 defect:

- Local `main` was `edfe8a3f4684b21aec7976ad900b37175cdd9f25`.
- Fetched `origin/main` was `542201004c51a5af8c457e0015a71b733c9a2e04`, which is also the direct parent of `af8969f`.
- Consequently, `git diff --stat main...af8969f` included 151 historical files and `git diff --check main...af8969f` reported an older blank line at `artifacts/agent-dashboard/src/lib/authSession.ts:111`. Neither belongs to the Phase 1 commit.
- The commit-accurate audit, `git diff af8969f^ af8969f`, contains 34 files, 2,106 insertions, 4 deletions, and passes `git diff --check`.

The only production-source changes in the commit-accurate diff are:

| File | Newly exported symbol | Function body changed | Imports/runtime changed | Why exported |
| --- | --- | --- | --- | --- |
| `artifacts/api-server/src/routes/readymode.ts` | `parseAgentTable` | no | no | Direct sanitized HTML parser fixture characterization |
| `artifacts/api-server/src/routes/readymode.ts` | `parseReadymodeRows` | no | no | Direct CSV parser fixtures and performance gate |
| `artifacts/api-server/src/routes/sheets.ts` | `detectHeaderRow` | no | no | Direct header-discovery characterization |
| `artifacts/api-server/src/routes/vos.ts` | `teamFromRingGroupName` | no | no | Direct PBX ring-group classifier fixture and performance gate |

Each diff is only the addition of the `export` keyword. No body, import, call site, response, calculation, matching rule, or runtime branch changed.

## Required twelve confirmations

### 1. What the mocked browser suite proves

`pnpm test:business-contracts` retains the intercepted-API Playwright suite. It proves that the existing frontend consumes the pinned normalized response contracts, exposes the expected pages/tabs/cards/tables, applies the current UI interactions, and produces its client CSV path. Because application API calls are fulfilled inside the browser, this suite does not prove Express routing, session middleware, or PostgreSQL wiring.

### 2. What the full-stack browser suite proves

`pnpm test:business-contracts:full-stack` runs Browser → real Vite frontend → real Express application → real disposable PostgreSQL. It performs real login, cookie refresh, `/auth/me`, logout/revocation, anonymous and forbidden checks, date/team filters, refresh, numeric cards/tables, By Call/Files/Day, client CSV, all four server XLSX downloads, sanitized backend error responses, and pages/endpoints backed by QUO, PBX, ReadyMode, Google Sheet 1, and Google Sheet 2. Browser application API interception is not used; only outbound provider hosts receive deterministic fixtures in the test server process.

The test records every browser `/api/` response and fails for an unexpected 4xx/5xx or a missing required route. Its latest expanded local run passed.

### 3. What the read-only deployment test proves

`pnpm test:staging-readonly` is optional and excluded from normal CI. With `STAGING_READONLY_BASE_URL`, `STAGING_READONLY_EMAIL`, and `STAGING_READONLY_PASSWORD` supplied only through the environment, it can prove that a deployed login/session, accessible dashboards, fixed closed historical range, team filter, valid number fields, nonblank source pages, read-only downloads, and logout work together.

It disables trace/video/screenshots and writes only normalized hashes, boolean checks, the fixed range, and route count to the gitignored `.artifacts/phase-1-staging-readonly/` directory. It never invokes an import, mutation, destructive job, QA write, blocked-number write, or AI write. It was not run in this acceptance session because deployment credentials were not available; no claim of live deployment verification is made.

### 4. Direct versus inventory-only endpoint coverage

The generated `phase-1-endpoint-coverage-matrix.md` inventories all 99 declared Express endpoints. The acceptance review found 37 inventory-only endpoints in the requested critical categories:

- 10 attendance/break endpoints enforcing permission, date, team, or agent scope.
- 3 Google-backed endpoints: the legacy CSV proxy and both violation-verification methods.
- 12 background-job, refresh, or QA-processing endpoints affecting visible dashboard freshness.
- 6 ReadyMode and NSF ReadyMode queue endpoints.
- 3 QUO refresh/sync endpoints.
- 3 PBX refresh/diagnostic endpoints.

None of these 37 had an existing direct real-Express response assertion strong enough to justify reclassification on its own. Each received a focused HTTP test in `dashboard-full-stack.spec.ts`: 35 private endpoints assert the stable unauthenticated `401` envelope, and the 2 public cron endpoints assert the sanitized `503` response when `CRON_SECRET` is not configured. Their matrix rows are now classified as direct HTTP authorization or secret-boundary integration coverage. Existing provider, scheduler, database, calculation, and authorization tests remain cited alongside that new route-level protection.

No inventory-only authentication/session, export, or standalone number-producing dashboard endpoint was found. The only remaining inventory-only rows are the three blocked-number administration routes, which are outside the requested critical categories. Therefore no critical endpoint remains inventory-only without a technical justification. The matrix now reports 89 endpoints with direct Phase 1 behavior/HTTP protection, 3 inventory-only endpoints, and 7 deliberate Samia business-behavior exclusions.

### 5. Performance metrics enforced by CI

Normal CI executes 21-iteration paired assertions for QUO mapping, PBX JSON parsing/classification, ReadyMode CSV parsing, Google Sheets parsing, XLSX generation, PostgreSQL grouped-query duration, PostgreSQL query count, key aggregate API duration, fixed-fixture six-response API data-ready duration, representative response payload bytes, and the synthetic large-payload byte count. The fixed operations are repeated within each sample until duration is large enough to avoid sub-10 ms timer noise, and calibration work is duration-matched so scheduler variation is not amplified. The grouped PostgreSQL gate uses measured Windows and Linux paired baselines because the database engine/calibration ratio differs consistently by platform; both retain the same 10% limit, identical query and calibration work, and the exactly-one-query assertion. Each other duration ratio and payload limit is capped at 110% of its recorded Phase 1 baseline.

CI also runs the real-stack browser suite as a deterministic functional data-ready gate: the actual frontend must visibly populate against Express/PostgreSQL within the test contract. It does not impose a 10% browser wall-clock threshold.

### 6. Performance metrics that are informational only

Full-stack browser data-visible time, large-table render time, and browser API request count are measured by `pnpm test:business-contracts:browser-performance` over 12 iterations. Browser timing is local/scheduled evidence rather than a normal-CI 10% gate because browser startup, rendering, JIT, and shared-runner scheduling are too noisy for that threshold. The 10/25/50-client load test is also a repeatable local baseline, not a Production or per-PR load test.

### 7. Performance before and after

Acceptance hardening changed measurement and enforcement, not the production implementation under measurement.

| Path | Phase 1 recorded p50 / p95 | Acceptance p50 / p95 | Acceptance enforcement |
| --- | ---: | ---: | --- |
| Key aggregate API | 4.455 / 5.665 ms warm | 258.340 / 280.337 ms per 20-request sample | normalized p50 ratio ≤ 1.206 |
| PostgreSQL aggregate | 4.456 / 5.658 ms warm | 23.911 / 29.018 ms over 80,000 rows | normalized p50 ratio ≤ 1.118; 1 query |
| Fixed-fixture API batch data-ready | 11.816 / 15.487 ms warm | 122.068 / 147.313 ms per 12 six-response batches | normalized p50 ratio ≤ 1.255; not browser timing |
| QUO mapping | 22.015 / 27.655 ms warm batch | 40.633 / 44.953 ms paired sample | normalized p50 ratio ≤ 1.266 |
| PBX JSON classification | 4.962 / 9.676 ms warm batch | 49.281 / 56.143 ms paired sample | normalized p50 ratio ≤ 1.288 |
| ReadyMode CSV | 7.378 / 11.161 ms warm batch | 41.974 / 61.114 ms paired sample | normalized p50 ratio ≤ 1.218 |
| Google Sheets | 5.560 / 8.300 ms warm batch | 51.900 / 61.227 ms paired sample | normalized p50 ratio ≤ 1.210 |

The absolute timings use different paired workloads/calibrations and are retained as evidence, not compared directly across harness versions. The executable comparison is the normalized Phase 1 ratio plus 10%. Full-stack browser measurements were 751.70/1,061.17 ms data-visible p50/p95, 572.16/674.31 ms large-table p50/p95, and 12 API requests p50/p95.

### 8. Concurrency results

The sanitized local load fixture contained 220,000 `phone_calls` rows across 120 synthetic agents. Each concurrency level sent 100 `/quo/stats` and 100 `/quo/live` requests.

| Clients | Endpoint | Requests/errors/timeouts | p50/p95/p99 | Peak pool total/active/waiting | Wait samples | Connection exhaustion |
| ---: | --- | --- | ---: | ---: | ---: | --- |
| 10 | QUO stats | 100/0/0 | 143.23/175.30/191.34 ms | 10/10/33 | 53 | no |
| 10 | QUO live | 100/0/0 | 157.25/205.08/205.48 ms | 10/10/33 | 53 | no |
| 25 | QUO stats | 100/0/0 | 289.21/340.18/344.33 ms | 10/10/106 | 77 | no |
| 25 | QUO live | 100/0/0 | 354.08/406.62/407.92 ms | 10/10/106 | 77 | no |
| 50 | QUO stats | 100/0/0 | 626.47/692.38/712.55 ms | 10/10/228 | 78 | no |
| 50 | QUO live | 100/0/0 | 670.25/880.59/881.46 ms | 10/10/228 | 78 | no |

Per-level RSS/heap and CPU evidence is recorded in `phase-1-performance-baseline.md`. No request failed or timed out; waiting above ten clients reflects the configured ten-connection pool rather than exhaustion.

### 9. Real backend routes work

Confirmed locally through the real-stack suite: the real Express health, auth/session, source/stat, attendance, violations, onboarding, QA, CSV, and XLSX paths returned their expected protected responses against disposable PostgreSQL and deterministic providers. The frontend’s route monitor observed no unexpected missing or broken application route.

### 10. Dashboards still display numbers

Confirmed locally. Retention summary/table content, Phones / Quo Lines, Phones / PBX, Phones / ReadyMode, and Backend Statistics visibly populated with positive sanitized fixture values through the real backend. The real-stack test fails if these source-backed views become blank.

### 11. Business logic did not change

Confirmed for acceptance hardening: no production frontend or backend runtime source was edited. Changes are test harnesses, fixtures, assertions, commands, CI wiring, generated inventory, and documentation. Golden values were not changed to hide a mismatch. PBX matching and IDP Handled/Retained calculations were not altered.

### 12. Samia was not modified

Confirmed. No Samia source, route behavior, fixture response, calculation, or capability changed. The matrix lists its seven endpoints as business-behavior excluded for this task and retains their existing centralized authorization assertion.

## Large-payload classification

The reported 3,427,751 bytes come from `performanceBaseline.integration.test.ts`, which serializes 250 repeated copies of the entire sanitized golden response object. It is not an endpoint payload, has no request date range, has no meaningful single application-record count, is synthetic rather than normal/maximum use, and is never sent to or rendered by a browser. CI now rejects growth beyond 3,770,526 bytes (110%); this task does not optimize it.

## Verification commands

Final local verification results:

- Existing API tests: 100 passed.
- Schema contract: all 79 objects passed.
- Security: 29 frontend tests passed; 114 backend checks passed with 9 environment-gated integrations intentionally skipped in the general command.
- Enabled authentication/access integrations: login-session 1/1, legacy-password upgrade 13/13, canonical access 15/15, and Agent Roster 14/14 passed against disposable PostgreSQL.
- Lint, all workspace typechecks, and both Production bundles passed.
- Endpoint matrix generation and its every-route assertion passed for 99 endpoints.
- Export value parity and all four real-stack XLSX HTTP downloads passed.
- The 10/25/50 concurrency baseline passed with zero errors and timeouts.
- `pnpm test:phase-1-acceptance:deterministic` passed three consecutive times after the benchmark calibration was duration-matched. Each complete run included 40 backend contracts, 14 frontend contracts, legacy and expanded performance gates, the intercepted browser suite, and the real-stack browser suite.
- The optional deployed read-only smoke was not run because its environment-only credentials were unavailable.
