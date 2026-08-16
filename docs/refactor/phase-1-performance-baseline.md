# Phase 1 performance baseline

Baseline captured on 2026-08-16 from `origin/main` SHA `542201004c51a5af8c457e0015a71b733c9a2e04` with Node 24.17.0 on Windows x64. The harness uses only sanitized fixtures, a local HTTP server, and a temporary 20,000-row table in the disposable PostgreSQL test database. It does not contact providers or Production.

Every benchmark uses three cold iterations and ten warm iterations. Parser warm figures are deliberately batched so the duration is measurable; the batch size is shown rather than presenting sub-millisecond estimates as precision.

## Recorded baseline

| Metric | Fixed work | Cold median / p95 | Warm median / p95 | Additional evidence |
| --- | ---: | ---: | ---: | --- |
| API latency | one `/api/quo/stats` golden response | 8.833 / 33.624 ms | 4.455 / 5.665 ms | 1,974 bytes; 0 errors |
| Database aggregate | one grouped range query over 20,000 rows | 4.266 / 4.705 ms database execution | 4.456 / 5.658 ms database execution | exactly 1 query; warm wall 6.968 / 8.543 ms |
| Full dashboard data-ready | six parallel representative API responses | 12.688 / 13.048 ms | 11.816 / 15.487 ms | 6 requests; 5,740 bytes |
| QUO mapping | 10,000 sanitized call mappings | 0.831 / 1.134 ms for one read/map | 22.015 / 27.655 ms batched | 5 fixture calls; duplicate retained |
| ReadyMode CSV import | 500 parses per warm sample | 1.869 / 2.807 ms | 7.378 / 11.161 ms batched | 4 accepted rows per parse |
| ReadyMode retained HTML parser | 500 parses per warm sample | 2.024 / 5.145 ms | 7.454 / 9.422 ms batched | 2 accepted rows per parse |
| PBX adapter | 1,000 JSON parse/classification passes | 0.753 / 1.319 ms | 4.962 / 9.676 ms batched | 3 agents, 3 ring groups, 2 calls |
| Google Sheets parsing | 1,000 three-tab parses | 1.637 / 2.155 ms | 5.560 / 8.300 ms batched | IDP Handled, Retained, Fixed |
| Large dashboard memory | 250 golden-response copies | n/a | n/a | 3,427,751-byte input; 4,663,688-byte observed heap delta |

Raw timings are evidence, not universal machine budgets. The executable portability gate pairs each QUO mapping sample with a fixed JSON calibration sample in the same process and takes the median ratio. Across three baseline captures the largest normalized median ratio was `1.156`; CI permits no more than 10% regression, so the enforced limit is `1.272`. The machine-readable threshold is in `phase-1-performance-baseline.json`.

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
