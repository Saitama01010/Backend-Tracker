# Phase 3 acceptance addendum

Accepted locally on 2026-08-21 without contacting staging or Production and
without beginning Phase 4 implementation.

## 1. Accepted branch, base, and diff

- Branch: `refactor/phase-3-service-repository-boundaries`.
- Accepted Phase 2 / fresh `origin/main` base:
  `1234543cd9b4ff2314887e9e61ab4b00439b50ad`.
- Reported Phase 3 runtime implementation:
  `2c990d17c10ebd89d938e19b578d59b716621e04`.
- Reported documentation head:
  `928803181ab09e9a791f0b3a57f554e8a712ffe8`.
- Final locally tested code and test-harness SHA:
  `9e7e99bd7930226183af405ceef4075dd2099920`.
- Before this addendum, the real `origin/main...HEAD` diff was 114 files,
  14,400 insertions, and 6,695 deletions.
- Final branch diff including this addendum: 115 files, 14,740 insertions,
  and 6,695 deletions.
- This addendum's commit cannot embed its own self-referential Git object ID.
  The pull request records the resulting final branch SHA, and the merge record
  records the accepted main SHA.

`origin/main` was the exact merge base and an ancestor of the Phase 3 branch;
the branch was 47 commits ahead and zero behind before final acceptance work.
`git diff --check` passed.

There is no production frontend source change, database schema or migration
change, business-rule change, or Samia change. One frontend **test-only** line
was added during acceptance to pin the browser to the permanent 2026-08-16
fixture date. Without that clock pin, running the fixture on 2026-08-21 created
a third ReadyMode date-cache key. Exact Phase 2 reproduced the same failure.
Pinning fixture time restored the accepted two-call count without changing any
runtime code, provider behavior, or expected value.

## 2. Structural architecture audit

The reported dependency direction is real for migrated flows:

`Route -> Validation -> Authorization -> Service -> Repository / Integration`

- Routes own HTTP inputs, status/header compatibility, and error mapping.
- Services own framework-independent orchestration and take explicit values;
  no migrated service imports Express `Request`, `Response`, or `Router`.
- Repositories own PostgreSQL queries and transactions.
- Accepted Phase 2 adapters still own provider authentication, transport, raw
  parsing, pagination, source files, and provider sessions.
- No repository performs provider transport.
- Migrated routes contain no reintroduced provider credentials, URLs, raw
  parsing, or large SQL.
- The largest new service is a cohesive 451-line QUO live orchestration module;
  no 1,500-line route was replaced with a generic service.
- The production API relative-import graph is acyclic.

Two repositories import `getSyncState` or `upsertQuoPhoneCallRows` from the
accepted Phase 2 `integrations/quo/sync.ts` module. Both helpers perform only
PostgreSQL reads/writes; neither calls a provider. Their historical module
placement is debt, not a repository-to-provider violation.

All 14 architecture tests passed. A temporary direct `@workspace/db` import in
`routes/sheets.ts` made the migrated-dashboard boundary check fail. The line was
removed completely, the test returned to 14/14, and the violation was not
committed.

## 3. Independently measured route reduction

| Route | Phase 2 LOC | Phase 3 LOC | Change |
| --- | ---: | ---: | ---: |
| `sheets.ts` | 172 | 76 | -96 |
| `readymode.ts` | 392 | 150 | -242 |
| `quo.ts` | 1,204 | 574 | -630 |
| `quoWebhook.ts` | 355 | 355 | 0 |
| `vos.ts` | 1,769 | 126 | -1,643 |
| `attendance.ts` | 787 | 231 | -556 |
| `qa.ts` | 1,084 | 268 | -816 |
| `nsfReadymode.ts` | 201 | 79 | -122 |
| `obAnalytics.ts` | 47 | 47 | 0 |
| `obReport.ts` | 107 | 107 | 0 |
| `liveTransfers.ts` | 60 | 60 | 0 |
| `violations.ts` | 450 | 71 | -379 |
| `users.ts` | 488 | 71 | -417 |
| **Total** | **7,116** | **2,215** | **-4,901 (-68.9%)** |

LOC was measured independently from the accepted Phase 2 tree and final Phase
3 tree with the same line-count method.

## 4. Remaining deliberate route debt

Direct route PostgreSQL access remains only in:

- `auth.ts`: security-sensitive authentication/session transactions.
- `blockedNumbers.ts`: small CRUD route outside Phase 3.
- `breaks.ts`: break lifecycle outside Phase 3.
- `quo.ts`: retained phone/sync compatibility operations.
- `quoWebhook.ts`: signed durable webhook receipt and call-state handling.
- `samia.ts`: explicitly frozen.
- `teamAgents.ts`: canonical roster identity behavior outside Phase 3.

Actual direct provider transport remains only in:

- `csvProxy.ts`: retained approved URL proxy.
- `quoWebhook.ts`: signed-webhook directory refresh behavior.
- `samia.ts`: explicitly frozen AI/QUO behavior.

`quo.ts` and `readymode.ts` also retain imports of accepted Phase 2 adapters for
operational sync/import/probe endpoints. Those are provider boundaries, not
provider transport or parsing reimplemented inside the routes.

## 5. Business and compatibility parity

- Independently recomputed normalized golden SHA-256:
  `ebf3dbb67ddf0a797d51577ca1fde13b753a5417318fa902a01b772a83bcc551`.
- Golden outputs were not updated.
- Deterministic response bytes remained exact:

| Endpoint | Bytes |
| --- | ---: |
| `/api/quo/stats` | 1,974 |
| `/api/sheet` | 767 |
| `/api/vos/stats` | 1,489 |
| `/api/readymode/stats` | 345 |
| `/api/attendance` | 431 |
| `/api/violations` | 734 |

- All accessible dashboard fixtures remained populated; missing provider data
  was not converted to synthetic zero values.
- Google Sheet 2 `IDP Handled Retained` still contributes to Retained while the
  other accepted sheet concepts remain distinct.
- PBX ring-group interpretation, aliases, matching order, ghost/callback rules,
  and date boundaries passed unchanged.
- ReadyMode parsing, duplicates, dates, source priority, cache behavior, queue
  behavior, and upload/probe boundaries passed unchanged.
- QUO calculations, stats/calls/live shapes, refresh behavior, and date/team/
  agent scopes passed unchanged.
- XLSX values, workbook bytes/magic, response headers, filenames, private cache
  controls, and browser downloads passed.
- Default-private authorization, all 85 declared private method/path policies,
  roles, teams, agents, tabs, dates, sessions, password upgrades, roster scope,
  and canonical access passed.
- Samia has no source diff and its identity, transcript, authorization,
  capability, reservation, privacy, audit, and no-startup-request tests passed.

The full-stack fixture retained this exact provider-call vector in all three
final consecutive runs:

```json
{"googleAuth":1,"googleMetadata":2,"googleSheet1":3,"googleSheet2":1,"readyModeCsv":2,"readyModeHtml":0,"pbx":9,"quo":6}
```

The important deterministic grouped request remained one database query in
every run.

## 6. Large QUO response behavior

The 220,000-row load fixture produced the same 1,051,639-byte `/api/quo/stats`
response in Phase 2 controls and all Phase 3 runs. The live payload remained
11,653 bytes.

- `phoneStatsAggregation.ts` is byte-for-byte unchanged from Phase 2.
- Phase 2 and Phase 3 both serialize the completed stats payload once and cache
  that serialized body; Phase 3 did not add another payload copy.
- The dataset remained exactly 220,000 generated rows and 120 agents.
- Important-request query count remained one.
- QUO fixture provider calls remained six.
- No run errored, timed out, exhausted the pool, or showed a monotonic runaway
  heap. Transient RSS/heap varied with garbage collection and concurrent
  serialization, as recorded below.

No API redesign or response-shape change was made.

## 7. Five independent concurrency runs

Each independent process regenerated 220,000 sanitized local PostgreSQL rows.
At each level it issued 100 stats requests and 100 live requests. Times are ms.

### Endpoint timings per run

| Run | Clients | Stats p50 / p95 / p99 | Live p50 / p95 / p99 |
| ---: | ---: | ---: | ---: |
| 1 | 10 | 177.67 / 256.88 / 289.43 | 208.58 / 302.65 / 303.27 |
| 1 | 25 | 347.02 / 410.71 / 417.39 | 416.76 / 508.28 / 509.26 |
| 1 | 50 | 723.95 / 766.89 / 769.57 | 852.51 / 1,237.74 / 1,240.01 |
| 2 | 10 | 170.33 / 186.02 / 237.23 | 221.49 / 260.63 / 261.45 |
| 2 | 25 | 397.39 / 471.57 / 475.75 | 474.27 / 561.87 / 562.82 |
| 2 | 50 | 726.23 / 777.67 / 783.94 | 712.48 / 1,010.07 / 1,010.23 |
| 3 | 10 | 158.16 / 234.36 / 244.98 | 198.30 / 226.28 / 228.48 |
| 3 | 25 | 338.20 / 395.76 / 400.11 | 440.02 / 507.69 / 508.41 |
| 3 | 50 | 753.64 / 782.66 / 820.55 | 743.22 / 1,017.25 / 1,018.94 |
| 4 | 10 | 169.64 / 243.94 / 285.00 | 207.90 / 238.57 / 239.30 |
| 4 | 25 | 354.08 / 423.50 / 432.71 | 441.45 / 561.03 / 561.40 |
| 4 | 50 | 730.17 / 778.54 / 789.58 | 797.18 / 1,270.71 / 1,272.57 |
| 5 | 10 | 176.25 / 202.22 / 209.74 | 197.78 / 211.20 / 212.48 |
| 5 | 25 | 338.11 / 381.20 / 388.08 | 469.84 / 566.01 / 566.62 |
| 5 | 50 | 821.30 / 858.15 / 873.31 | 772.67 / 1,059.82 / 1,060.72 |

### Five-run medians versus the historical Phase 2 capture

| Clients | Endpoint | Phase 2 p50 / p95 | Phase 3 median p50 / p95 | Median change |
| ---: | --- | ---: | ---: | ---: |
| 10 | stats | 115.17 / 154.14 | 170.33 / 234.36 | +47.9% / +52.0% |
| 10 | live | 137.43 / 155.47 | 207.90 / 238.57 | +51.3% / +53.5% |
| 25 | stats | 236.49 / 262.06 | 347.02 / 410.71 | +46.7% / +56.7% |
| 25 | live | 294.97 / 353.65 | 441.45 / 561.03 | +49.7% / +58.6% |
| 50 | stats | 548.76 / 577.39 | 730.17 / 778.54 | +33.1% / +34.8% |
| 50 | live | 522.64 / 723.16 | 772.67 / 1,059.82 | +47.8% / +46.6% |

The historical absolute capture is not reproducible under the current host
conditions. Two same-host runs of the exact accepted Phase 2 SHA produced:

| Control | Clients | Stats p50 / p95 / p99 | Live p50 / p95 / p99 |
| ---: | ---: | ---: | ---: |
| Phase 2 run 1 | 50 | 961.85 / 1,136.18 / 1,150.66 | 784.93 / 1,099.95 / 1,101.75 |
| Phase 2 run 2 | 50 | 784.58 / 852.45 / 860.35 | 843.13 / 1,162.68 / 1,163.00 |

Phase 3's five-run median 50-client p95 was faster than both current Phase 2
controls for both endpoints. Against the mean of those controls, Phase 3 was
21.7% faster for stats p95 and 6.3% faster for live p95. The older absolute
delta is therefore repeatable environmental/scheduling drift, not Phase 3
service/repository overhead. No threshold was loosened and no unnecessary
runtime optimization was made.

### Errors, pool, and memory per run

Every row had zero endpoint errors, zero timeouts, and no connection exhaustion.
The pool peaked at 10 total/active connections; waiters represent bounded
queued work, not exhausted or failed connections.

| Run | Clients | Peak waiters | RSS delta bytes | Heap delta bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 10 | 35 | +96,534,528 | +11,615,640 |
| 1 | 25 | 107 | +57,565,184 | +19,616,640 |
| 1 | 50 | 208 | +46,505,984 | +12,159,016 |
| 2 | 10 | 34 | -25,395,200 | +8,035,856 |
| 2 | 25 | 106 | +73,723,904 | +11,773,992 |
| 2 | 50 | 232 | +161,701,888 | +30,100,224 |
| 3 | 10 | 34 | -27,471,872 | +25,031,656 |
| 3 | 25 | 109 | +77,303,808 | +16,699,056 |
| 3 | 50 | 211 | +143,020,032 | +6,958,216 |
| 4 | 10 | 35 | -23,433,216 | +30,778,296 |
| 4 | 25 | 112 | +86,695,936 | -21,177,608 |
| 4 | 50 | 239 | +127,090,688 | +51,552,712 |
| 5 | 10 | 36 | -23,670,784 | +15,947,736 |
| 5 | 25 | 110 | +71,979,008 | -8,016,440 |
| 5 | 50 | 236 | +31,318,016 | +46,088,264 |

## 8. Deterministic performance acceptance

The complete deterministic acceptance command passed three consecutive times
after the final test-harness change. The executable thresholds were unchanged.

| Path | Final run ratios (1 / 2 / 3) | Worst | +10% maximum | Result |
| --- | ---: | ---: | ---: | --- |
| QUO mapping | 1.128 / 1.117 / 1.038 | 1.128 | 1.266 | pass |
| PBX parse/map | 1.127 / 1.074 / 1.094 | 1.127 | 1.288 | pass |
| ReadyMode parse | 0.967 / 0.922 / 0.981 | 0.981 | 1.218 | pass |
| Google Sheets parse | 1.038 / 1.096 / 1.093 | 1.096 | 1.210 | pass |
| XLSX generation | 0.907 / 0.812 / 0.931 | 0.931 | 1.228 | pass |
| PostgreSQL | 1.164 / 1.128 / 1.101 | 1.164 | 1.260 | pass; 1 query |
| Aggregate API | 1.004 / 1.000 / 0.985 | 1.004 | 1.206 | pass |
| Six-response data-ready | 1.002 / 1.103 / 0.907 | 1.103 | 1.255 | pass |

The informational real browser run also passed: populated data visible p50/p95
773.13/989.42 ms, 250-row table render p50/p95 578.96/656.76 ms, and exactly
12 API requests at p50, p95, minimum, and maximum.

## 9. Deliberate-failure controls

- Architecture: a migrated route directly imported `@workspace/db`; the
  appropriate architecture boundary test failed. Restored result: 14/14.
- Business: the locked QUO Retention total for Agent Alpha was changed from 12
  to 13; the contract failed with `12 !== 13`. Restored result: 4/4 focused
  golden tests and the original hash.
- Performance: a second Google Sheets parse workload was added to the operation
  side only; the unchanged gate failed at normalized ratio 2.124 versus maximum
  1.21. Restored result passed at 1.074, followed by three complete green runs.

All artificial changes were removed and none was committed.

## 10. Final local verification matrix

| Gate | Result |
| --- | --- |
| Three consecutive complete deterministic acceptance runs | pass |
| API business contracts | 41/41 each run |
| Frontend business contracts | 14/14 each run |
| Browser contract | 1/1 each run |
| Real Vite -> Express -> PostgreSQL | 2/2 each run |
| API unit/domain/architecture | 186/186 |
| Phase 3 Violations/User tests | 4/4 |
| Frontend security | 29/29 |
| API security | 114 pass, 9 separately gated skips |
| Security-CI policy | 4/4 |
| Dependency audit | no high or critical advisories |
| Gitleaks 8.30.1 full working-directory scan | pass |
| Login/session integration | 1/1 |
| Agent roster | 14/14 |
| Canonical access | 15/15 |
| AI reservations / cleanup | 1/1 and 4/4 |
| Durable background jobs | 1/1 |
| Signed webhook integration | 1/1 |
| NSF ReadyMode integration | 2/2 |
| Attendance migration/note/data correctness | 12/12 |
| Legacy password upgrade | 13/13 |
| Schema contract | 79/79 objects |
| Release readiness | 4/4 |
| Database performance/equivalence | 4/4 |
| Frontend performance | 13/13 |
| Typecheck | pass |
| ESLint `--max-warnings=0` | pass |
| API and frontend Production builds | pass |
| Frontend bundle budget | pass; 906,984 raw / 265,327 gzip bytes |
| Browser informational performance | 1/1 |
| Five Phase 3 load runs | 3,000/3,000 requests; zero failures |

The successful Vite build retains its known Rollup large-chunk and third-party
sourcemap reporting advisories. ESLint itself completed with zero warnings.

## 11. Staging and release boundary

`STAGING_READONLY_BASE_URL`, `STAGING_READONLY_EMAIL`, and
`STAGING_READONLY_PASSWORD` were all absent, so the optional read-only staging
smoke was not run. No staging or Production endpoint, provider, database, data,
or deployment was contacted or changed. This addendum authorizes no manual
Production deployment.

## 12. Remaining debt and Phase 4 boundary

- `samia.ts`, `quoWebhook.ts`, retained `quo.ts` operational paths, `auth.ts`,
  `teamAgents.ts`, `breaks.ts`, and `blockedNumbers.ts` remain deliberate route
  debt.
- `csvProxy.ts` remains a deliberate direct-provider proxy.
- The DB-only QUO sync helpers remain historically located in an integration
  module.
- Onboarding/Live Transfer application modules and the main frontend bundle
  remain large but were outside this backend structural phase.
- The local concurrency harness is not a long-duration distributed soak.

No database hardening, schema change, migration change, query redesign, or
other Phase 4 implementation occurred during Phase 3 acceptance.
