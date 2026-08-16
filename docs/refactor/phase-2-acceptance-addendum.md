# Phase 2 acceptance addendum

Accepted on 2026-08-16 without contacting staging or Production and without
starting Phase 3 implementation.

## 1. Accepted branch and base

- Branch: `refactor/phase-2-source-adapters`
- Final tested implementation SHA: `e57b3500bb43b1f46c5bd2a1473b4ed4f0469509`
- Fresh `origin/main` base SHA: `60f98d313c601b93651ae0ced6efc7f856d2a642`
- `origin/main` is the exact merge base and an ancestor of the accepted
  implementation. No rebase was required.
- This addendum is committed after the tested implementation, so the
  documentation-only commit cannot contain its own Git object ID. The PR and
  merge record identify the resulting branch and merged-main SHAs.

## 2. Complete `origin/main...HEAD` diff audit

The accepted implementation diff contains 26 files, 1,777 insertions, and 982
deletions before this addendum:

- Production files: four compatibility routes, one integration-policy module,
  and eleven new source-adapter files.
- Test/test-infrastructure files: nine.
- Documentation files: `phase-2-report.md` plus this addendum.
- Routes modified: `routes/sheets.ts`, `routes/readymode.ts`, `routes/vos.ts`,
  and `routes/quo.ts`.
- Integration files added:
  - Google Sheets: `client.ts`, `mapper.ts`.
  - ReadyMode: `client.ts`, `csvParser.ts`, `htmlParser.ts`, `htmlProbe.ts`,
    `importer.ts`.
  - PBX: `client.ts`, `mapper.ts`.
  - QUO: `client.ts`, `dashboardMapper.ts`.

Provider authentication, HTTP transport, raw response parsing, pagination, and
source-specific file/session handling moved from the four migrated routes into
those adapters. Route authorization, caching, date/team/agent filtering,
business calculations, response shapes, persistence, and errors remained in
their existing compatibility routes.

`git diff --check origin/main...HEAD` passed. There are no frontend source,
database schema, migration, KPI, permission, export, scheduler, or Samia changes.

## 3. Whole-backend integration-boundary audit

The complete Production backend was searched, rather than only the Phase 2
diff. The migrated dashboard routes contain no accidental provider URL,
credential, direct `fetch`, raw pagination, login/session, or filesystem-source
implementation.

Architecture tests now require the migrated routes to import the appropriate
adapters and reject direct transport/parsing markers. Security tests separately
pin QUO pacing, retry, participant/date query construction, and request-driven
refresh behavior at the adapter boundary.

## 4. Remaining provider-specific references and classification

### QUO/OpenPhone

- `integrations/quo/client.ts`, `sync.ts`, and `transcripts.ts`: legitimate,
  distinct integration-layer clients for dashboard reads, historical sync, and
  transcripts.
- `routes/quo.ts`: compatibility route; it contains QUO domain labels and
  business mapping but delegates provider transport and raw response handling.
- `routes/quoWebhook.ts` and `lib/openPhoneWebhook.ts`: legitimate signed-webhook
  integration path with different authentication and durable delivery rules.
- `lib/quoCall.ts`: compatibility wrapper for bounded transcript/summary access
  used by QA and Samia.
- `routes/samia.ts`: pre-existing frozen compatibility exception for Samia call
  analysis. It was explicitly excluded from Phase 2 and is not duplicated by a
  migrated dashboard route.
- Other routes/modules mentioning OpenPhone or QUO consume database rows,
  shared helpers, or presentation labels; they do not duplicate provider
  transport/parsing.

### PBX/VoSLogic

- `integrations/pbx/client.ts` and `mapper.ts`: legitimate integration-layer
  login, cookie lifecycle, authenticated JSON retrieval, and mapping.
- `routes/vos.ts`: compatibility route retaining cache, database, callback, and
  dashboard orchestration only.
- `lib/operationalConfig.ts`: configuration.
- Samia and other routes use stored PBX dashboard data or labels, not duplicate
  PBX provider transport.
- No Production PBX HTML ingestion path exists. The retained HTML fixture is
  test evidence only and no new runtime path was invented.

### ReadyMode

- `integrations/readymode/*`: legitimate CSV transport/parsing/import and the
  separate retained HTML login/session/probe/parser integration paths.
- `routes/readymode.ts`: compatibility route retaining authorization, cache,
  date filtering, merging, response shaping, and persistence orchestration.
- `lib/operationalConfig.ts`: ReadyMode URL/sheet configuration.
- `routes/nsfReadymode.ts` and the Samia CSV helpers are separate queue/general
  compatibility behavior, not duplicated ReadyMode provider transport.

### Google Sheets

- `integrations/googleSheets/client.ts` and `mapper.ts`: legitimate OAuth,
  Sheets API, metadata/value retrieval, and raw-row parsing.
- `routes/sheets.ts`: compatibility route retaining allowlisting, cache,
  authorization, roster scoping, compact response shaping, and errors.
- `lib/operationalConfig.ts`: spreadsheet IDs, gids, and source configuration.
- `lib/externalIntegrationPolicy.ts`: configuration validation and exact source
  allowlisting.
- Test fixtures and contract tests are test-only references.

No remaining occurrence was classified as an accidental migrated-dashboard
architectural leak.

## 5. Provider call-count parity

The same sanitized Phase 1 full-stack fixture/browser scenario was instrumented
on fresh `origin/main` and on accepted Phase 2. Counts are exact network-fixture
invocations, not estimates:

| Source | Phase 1 | Accepted Phase 2 | Result |
| --- | ---: | ---: | --- |
| QUO | 6 | 6 | preserved |
| PBX, including login | 9 | 9 | preserved |
| ReadyMode configured CSV | 2 | 2 | preserved |
| ReadyMode HTML | 0 | 0 | preserved |
| Google Sheet 1 value calls | 3 | 3 | preserved |
| Google Sheet 2 value calls | 1 | 1 | preserved |
| Google OAuth | 1 | 1 | preserved |
| Google metadata | 2 | 2 | preserved |

An intermediate Phase 2 run exposed 11 PBX calls because concurrent first-use
requests each logged in. In-flight session coalescing restored the accepted count
to 9 without changing credentials, cookie expiry, retry, result, or route logic.
Every final full-stack run asserts the table above.

## 6. Database query-count parity

- Accepted Phase 1 important-request count: 1 query.
- Accepted Phase 2 deterministic result: 1 query.
- Provider extraction added no new database query path.
- The 10/25/50-client load test completed with a 10-connection pool, no
  connection exhaustion, no errors, and no timeouts.

## 7. Response hash parity

The normalized major-dashboard response SHA-256 remained:

`ebf3dbb67ddf0a797d51577ca1fde13b753a5417318fa902a01b772a83bcc551`

The deliberate expected-value negative control did not alter this file or hash.

## 8. Payload parity

Deterministic payload bytes remained exact:

| Endpoint | Bytes |
| --- | ---: |
| `/api/quo/stats` | 1,974 |
| `/api/sheet` | 767 |
| `/api/vos/stats` | 1,489 |
| `/api/readymode/stats` | 345 |
| `/api/attendance` | 431 |
| `/api/violations` | 734 |

The synthetic 250-copy harness payload remained 3,427,751 bytes.

## 9. Dashboard parity

The business and browser suites verified the same populated sanitized fixture
values across every accessible dashboard page, including QUO, PBX, ReadyMode,
Retention, NSF, CS, onboarding, attendance, violations, callbacks, QA, user
management, roster, and phone views. Filters, refresh, subtabs, tables, and
downloads remained functional. No zero-filled provider failure was accepted.

## 10. Export parity

Export contracts passed. Workbook magic bytes, overview KPI values, ranking
cells, onboarding analytics values, response headers, and browser download flows
remained equivalent.

## 11. Authorization and authentication parity

Default-private authorization, role/team/agent/date restrictions, today-only
boundaries, canonical roster scope, session rotation/revocation, legacy password
upgrade, generic authentication failures, rate limits, admin-only integration
controls, and webhook authentication all passed. Phase 2 changed no permission
or authentication implementation.

## 12. Deterministic performance formula

Each gate alternates operation and calibration order for 21 paired samples:

`pair_ratio_i = operation_ms_i / max(calibration_ms_i, 0.000001)`

`normalized_ratio = median(pair_ratio_1 ... pair_ratio_21)`

`maximum = accepted_phase_1_normalized_ratio * 1.10`

`actual_regression_percent = (current_normalized_ratio / accepted_phase_1_normalized_ratio - 1) * 100`

The raw p50 columns below are descriptive; the normalized value is the median of
the paired ratios and therefore is not necessarily raw operation p50 divided by
raw calibration p50.

## 13. Final raw and normalized performance results

The final of three consecutive accepted runs produced:

| Benchmark | Phase 1 baseline | Operation p50 ms | Calibration p50 ms | Normalized | Actual regression | +10% maximum | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| QUO mapping | 1.151 | 43.849 | 38.519 | 1.150 | -0.09% | 1.266 | pass |
| PBX JSON parse/map | 1.171 | 44.871 | 40.652 | 1.104 | -5.72% | 1.288 | pass |
| ReadyMode CSV parse | 1.107 | 36.143 | 35.538 | 1.017 | -8.13% | 1.218 | pass |
| Google Sheets parse | 1.100 | 46.756 | 42.430 | 1.117 | +1.55% | 1.210 | pass |
| Export generation | 1.116 | 43.420 | 44.178 | 1.039 | -6.90% | 1.228 | pass |
| PostgreSQL duration | 1.145 | 21.059 | 20.968 | 1.060 | -7.42% | 1.260 | pass |
| Aggregate API | 1.096 | 266.449 | 263.062 | 1.011 | -7.76% | 1.206 | pass |
| Fixed-fixture data-ready batch | 1.141 | 138.345 | 135.181 | 0.987 | -13.50% | 1.255 | pass |

Calibration is performed inside every pair. PostgreSQL additionally selects the
recorded Windows platform baseline (`1.145`); no multiplicative platform factor
is applied to the current sample. Other rows have no platform-baseline override.
All three complete runs passed without changing thresholds.

## 14. Meaning of the reported Google Sheets `1.117`

`1.117` means the Sheets operation took a median paired ratio of 1.117 times its
same-run calibration workload. It does **not** mean Phase 2 was 11.7% slower than
Phase 1. Relative to the accepted Phase 1 normalized baseline of `1.100`, the
actual deterministic regression is `(1.117 / 1.100 - 1) * 100 = 1.55%`, inside
the `1.210` maximum.

## 15. Meaning of the previously reported PostgreSQL `1.109`

The earlier `1.109` was likewise a calibrated operation/control ratio, not a
10.9% Phase 2 regression. Against the Windows Phase 1 baseline `1.145`, it
represented `(1.109 / 1.145 - 1) * 100 = -3.14%`; the maximum remained `1.260`.
The final acceptance run measured `1.060` (`-7.42%`). Query count stayed 1.

## 16. Intentional performance-regression detection

A temporary second Google Sheets parsing workload was inserted into the
operation side only. With the unchanged baseline and threshold, the gate failed:

`googleSheetsParsing normalized p50 ratio 2.235 exceeds 10% limit 1.21`

The artificial line was completely discarded and the restored gate passed in
all three consecutive acceptance runs.

## 17. Intentional business-value regression detection

The locked expected QUO Retention total for Agent Alpha was temporarily changed
from 12 to 13. The contract suite failed with `12 !== 13`. The artificial change
was completely discarded; the restored golden/business suites passed and the
normalized response hash remained unchanged.

## 18. 10/25/50-client concurrency results

Each level issued 200 requests against 220,000 sanitized local PostgreSQL rows:

| Clients | QUO stats p50/p95 ms | QUO live p50/p95 ms | Errors | Timeouts | Pool exhausted |
| ---: | ---: | ---: | ---: | ---: | --- |
| 10 | 115.17 / 154.14 | 137.43 / 155.47 | 0 | 0 | no |
| 25 | 236.49 / 262.06 | 294.97 / 353.65 | 0 | 0 | no |
| 50 | 548.76 / 577.39 | 522.64 / 723.16 | 0 | 0 | no |

The informational browser run also passed: populated data p50/p95
816.23/1,167.34 ms, large-table render 575.75/852.63 ms, and exactly 12 API
requests at p50 and p95.

## 19. PBX matching confirmation

PBX ring-group interpretation, display-name aliases, matching order, callback
logic, and known inaccurate-name compatibility remain unchanged. Contract tests
pin the current aliases and result digest. The only acceptance hardening was
coalescing concurrent first-use logins to preserve the Phase 1 provider-call
count.

## 20. Samia confirmation

`routes/samia.ts`, `lib/quoCall.ts`, Samia UI, prompts, capabilities, direct call
analysis behavior, and stored-data behavior have no `origin/main...HEAD` diff.
No Samia path was refactored.

## Verification matrix and release boundary

Passed locally on the accepted implementation:

- Phase 1 backend/frontend business contracts and export parity.
- Phase 2 source contracts and architecture boundaries.
- Browser dashboard contracts and full Vite -> Express -> PostgreSQL flow.
- Authorization, security, session/authentication, background jobs, webhooks,
  canonical access, legacy password upgrade, roster, AI reservation, and data
  correctness suites.
- Database schema contract: 79 objects.
- Dependency audit and security/secret-scanning policy checks.
- Typecheck, lint, and Production build.
- Deterministic performance gates, three consecutive complete acceptance runs.
- Dedicated database performance benchmark, informational browser timing, and
  10/25/50-client load.

The optional staging read-only smoke was not run because
`STAGING_READONLY_BASE_URL`, `STAGING_READONLY_EMAIL`, and
`STAGING_READONLY_PASSWORD` were unavailable. This did not block publication.
No staging or Production service, provider, database, data, or deployment was
contacted or changed.

One informational browser-timing attempt initially followed the standalone
database benchmark in the same disposable database. That benchmark intentionally
uses a reduced benchmark table, so the later full-stack seed could not find the
normal test schema. The named disposable database was recreated with the guarded
empty-database bootstrap, the 79-object schema contract passed, and browser
timing then passed. This was test-environment ordering, not an application or
schema migration failure.
