# Phase 1 performance baseline

Baseline captured on 2026-08-16 from `origin/main` SHA `542201004c51a5af8c457e0015a71b733c9a2e04` with Node 24.17.0 on Windows x64. The harness uses only sanitized fixtures, a local HTTP server, and a temporary 20,000-row table in the disposable PostgreSQL test database. It does not contact providers or Production.

Every benchmark uses three cold iterations and ten warm iterations. Parser warm figures are deliberately batched so the duration is measurable; the batch size is shown rather than presenting sub-millisecond estimates as precision.

## Recorded baseline

| Metric | Fixed work | Cold median / p95 | Warm median / p95 | Additional evidence |
| --- | ---: | ---: | ---: | --- |
| API latency | one `/api/quo/stats` golden response | 8.833 / 33.624 ms | 4.455 / 5.665 ms | 1,974 bytes; 0 errors |
| Database aggregate | one grouped range query over 20,000 rows | 4.266 / 4.705 ms database execution | 4.456 / 5.658 ms database execution | exactly 1 query; warm wall 6.968 / 8.543 ms |
| Fixed-fixture API batch data-ready | six parallel responses from a local golden-response HTTP server | 12.688 / 13.048 ms | 11.816 / 15.487 ms | 6 requests; 5,740 bytes; **not a browser measurement** |
| QUO mapping | 10,000 sanitized call mappings | 0.831 / 1.134 ms for one read/map | 22.015 / 27.655 ms batched | 5 fixture calls; duplicate retained |
| ReadyMode CSV import | 500 parses per warm sample | 1.869 / 2.807 ms | 7.378 / 11.161 ms batched | 4 accepted rows per parse |
| ReadyMode retained HTML parser | 500 parses per warm sample | 2.024 / 5.145 ms | 7.454 / 9.422 ms batched | 2 accepted rows per parse |
| PBX adapter | 1,000 JSON parse/classification passes | 0.753 / 1.319 ms | 4.962 / 9.676 ms batched | 3 agents, 3 ring groups, 2 calls |
| Google Sheets parsing | 1,000 three-tab parses | 1.637 / 2.155 ms | 5.560 / 8.300 ms batched | IDP Handled, Retained, Fixed |
| Synthetic JSON parse memory | 250 copies of the complete golden fixture object | n/a | n/a | 3,427,751-byte input; 4,663,688-byte observed heap delta; no endpoint or browser |

Raw timings are evidence, not universal machine budgets. The executable portability gate pairs each QUO mapping sample with a fixed JSON calibration sample in the same process and takes the median ratio. Across three baseline captures the largest normalized median ratio was `1.156`; CI permits no more than 10% regression, so the enforced limit is `1.272`. The machine-readable threshold is in `phase-1-performance-baseline.json`.

## Acceptance hardening measurements and executable gates

The original table above remains the Phase 1 “before hardening” capture. Acceptance hardening did not change the implementation under measurement; it added 21-iteration paired measurements and executable 10% assertions. Sub-10 ms samples proved too sensitive to timer/scheduler noise during the required consecutive runs, so the deterministic harness repeats the same fixed Phase 1 operation until each sample is tens or hundreds of milliseconds. It uses 4,000 QUO fixture batches, 8,000 PBX fixture batches, 2,500 ReadyMode parses, 8,000 Sheets parses, four exports, 80,000 temporary database rows, 20 key API requests, and twelve six-response data-ready batches per sample. Calibration work is sized to approximately the same duration as each operation so scheduling variation is not amplified. The baseline ratio for each gate is the largest of three captures. Raw p50/p95 below is the final capture; enforcement uses the paired p50 operation/calibration ratio plus exactly 10%.

| Deterministic path | Acceptance p50 / p95 | Recorded normalized p50 | Enforced maximum (+10%) | CI status |
| --- | ---: | ---: | ---: | --- |
| QUO mapping | 40.633 / 44.953 ms | 1.151 | 1.266 | enforced |
| PBX JSON parsing/classification | 49.281 / 56.143 ms | 1.171 | 1.288 | enforced |
| ReadyMode CSV parsing | 41.974 / 61.114 ms | 1.107 | 1.218 | enforced |
| Google Sheets JSON parsing | 51.900 / 61.227 ms | 1.100 | 1.210 | enforced |
| XLSX export generation | 46.095 / 71.258 ms | 1.116 | 1.228 | enforced |
| PostgreSQL grouped aggregate | 23.911 / 29.018 ms | 1.016 | 1.118 | enforced; exactly one query |
| Key aggregate API response batch | 258.340 / 280.337 ms | 1.096 | 1.206 | enforced; 20 requests per sample |
| Fixed-fixture six-response API data-ready batches | 122.068 / 147.313 ms | 1.141 | 1.255 | enforced; 12 batches per sample; **not browser timing** |

The same test enforces each representative response payload at no more than 110% of its recorded byte count and enforces the synthetic large-payload harness at no more than 3,770,526 bytes. These gates run in normal CI through `pnpm test:business-contracts`. The legacy evidence capture and deterministic gate execute as separate serial test processes so the two benchmark harnesses cannot distort each other's timing.

## Real full-stack browser measurements (informational)

`pnpm test:business-contracts:browser-performance` uses the real Vite frontend, real Express routes, and the disposable PostgreSQL database. Only outbound provider hosts receive sanitized fixtures. Twelve iterations produced:

| Browser metric | Dataset/work | p50 | p95 | Enforcement |
| --- | --- | ---: | ---: | --- |
| Full-stack browser data-visible | reload, authenticated session, Retention panel visibly populated | 751.70 ms | 1,061.17 ms | informational local/scheduled |
| Large-table render | 250 sanitized Google Sheet rows through real `/api/sheet` and Backend Statistics UI | 572.16 ms | 674.31 ms | informational local/scheduled |
| Browser API request count | same full-stack navigation | 12 | 12 | informational; min/max also 12 |

This browser timing is deliberately not a normal-CI threshold: browser startup, JIT, rendering, and shared-runner scheduling are noisy enough that a 10% wall-clock gate would be flaky. Functional full-stack data readiness remains CI-enforced by `pnpm test:business-contracts:full-stack`; deterministic parser/API/DB/export/payload duration gates remain in normal CI.

## Concurrency baseline

`pnpm --filter @workspace/api-server run test:load` generated 220,000 sanitized PostgreSQL `phone_calls` rows across 120 synthetic agents and exercised `/api/quo/stats` plus `/api/quo/live`. Each endpoint received 100 requests at each level (200 total requests per level). No Production system or provider was contacted.

| Clients | Endpoint | Requests / errors / timeouts | p50 / p95 / p99 | Pool peak total / active / waiting | Wait samples | RSS delta | Heap delta | CPU user / system | Exhausted |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 10 | QUO stats | 100 / 0 / 0 | 143.23 / 175.30 / 191.34 ms | 10 / 10 / 33 | 53 | 106,844,160 B | 23,747,712 B | 4,313 / 1,125 ms (level total) | no |
| 10 | QUO live | 100 / 0 / 0 | 157.25 / 205.08 / 205.48 ms | 10 / 10 / 33 | 53 | same level sample | same level sample | same level sample | no |
| 25 | QUO stats | 100 / 0 / 0 | 289.21 / 340.18 / 344.33 ms | 10 / 10 / 106 | 77 | 128,102,400 B | 35,918,096 B | 3,703 / 1,218 ms (level total) | no |
| 25 | QUO live | 100 / 0 / 0 | 354.08 / 406.62 / 407.92 ms | 10 / 10 / 106 | 77 | same level sample | same level sample | same level sample | no |
| 50 | QUO stats | 100 / 0 / 0 | 626.47 / 692.38 / 712.55 ms | 10 / 10 / 228 | 78 | 86,462,464 B | -7,803,616 B | 4,109 / 1,172 ms (level total) | no |
| 50 | QUO live | 100 / 0 / 0 | 670.25 / 880.59 / 881.46 ms | 10 / 10 / 228 | 78 | same level sample | same level sample | same level sample | no |

Pool waiting is expected once concurrency exceeds the configured ten connections. “Exhausted” is false because every request completed, with zero timeouts and zero error responses. Negative heap delta at 50 clients reflects garbage collection during the sampled level, not a fabricated zero.

## Classification of the 3,427,751-byte payload

- Producer: `performanceBaseline.integration.test.ts`, not an Express endpoint.
- Harness: `JSON.stringify(Array.from({ length: 250 }, () => golden))`, followed by one `JSON.parse` for a memory observation.
- Dataset: 250 repeated copies of the entire sanitized `major-dashboard-responses.json` object. It is not 250 rows from one endpoint.
- Date range: none. The copied fixture contains its own sanitized example dates, but the harness performs no range request.
- Record count: 250 top-level copies; there is no meaningful application-record count because each copy contains multiple unrelated response shapes.
- Use classification: synthetic stress input, neither normal use nor a measured maximum supported request.
- Browser impact: not applicable; the payload is never sent to a browser, parsed by frontend code, or rendered.
- Gate: byte size must remain at or below 110% of 3,427,751 bytes. This task intentionally does not optimize it.

## Frontend request-count baseline

These counts come from the traced page-to-endpoint inventory. Shared React Query caching may reduce network traffic after navigation; the counts below pin the maximum distinct endpoint dependencies of a cold page load.

| Pages | Endpoint dependencies |
| --- | ---: |
| Login | 5 |
| Backend Statistics | 2 |
| Retention / Internal CS / NSF | 9 each |
| Ready-Mode Killers | 8 |
| Missed / No Callback | 7 |
| Callback Review | 1 |
| Violations | 4 |
| Retention QA / Onboarding | 8 each |
| Phones: Quo Lines | 4 |
| Phones: PBX / ReadyMode | 3 each |
| Attendance | 6 |
| Manage Users / Agent Roster / Blocked Numbers | 5 / 4 / 3 |
| Samia | 4 |

## Response payload baseline

| Representative response | Bytes |
| --- | ---: |
| `/api/quo/stats` | 1,974 |
| `/api/sheet` | 767 |
| `/api/vos/stats` | 1,489 |
| `/api/readymode/stats` | 345 |
| `/api/attendance` | 431 |
| `/api/violations` | 734 |

## Repeat command

```powershell
$env:DATABASE_URL='postgresql://phase1:phase1@127.0.0.1:54341/backend_tracker_phase1_test'
$env:BUSINESS_CONTRACT_DATABASE_URL=$env:DATABASE_URL
$env:DATABASE_ENVIRONMENT='test'
pnpm --filter @workspace/api-server run test:business-contracts:performance
```

The database guard refuses non-local databases and names that do not contain `test`, `phase1`, or `performance`.
