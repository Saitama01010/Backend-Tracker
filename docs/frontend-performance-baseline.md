# Frontend performance baseline — hardening/11

## Scope

- Branch: `hardening/11-frontend-performance`
- Base: `hardening/10-background-jobs` at `2694da7e4c8a43a6c1eaa641669339e6ce3c57ae`
- Local-only work. Nothing was merged, pushed, deployed, or applied to `main`.
- Measurements used the production build served on localhost with a disposable PostgreSQL database and sanitized local credentials.

## Before and after

| Measurement | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Initial JavaScript entry, minified | 2,074,709 B | 890,503 B | -57.1% |
| Initial JavaScript entry, gzip | 481,320 B | 258,746 B | -46.2% |
| Initial JavaScript transferred in browser (Brotli) | 461,430 B | 256,233 B | -44.5% |
| DOM content loaded | 175.6 ms | 128.3 ms median | -26.9% |
| Window load | 409.6 ms | 286.5 ms median | -30.1% |
| First contentful paint | 432 ms | 260 ms median | -39.8% |
| Entry-script download duration | 81.9 ms | 43.7 ms median | -46.6% |
| API requests in a five-minute active Retention window | 58 / 314.1 s | 24 / 320.4 s | -58.6% |
| API transfer in that window | 23,084 B | 8,670 B | -62.4% |
| Used JS heap after that window | 14.63 MB | 13.43 MB | -8.2% |
| 2,000-row / 10-column table benchmark | 386.4 ms median | 27.9 ms median for the 100-row page | -92.8% |

Browser load timings are local measurements and naturally vary. The after-load result is the median of three cold-cache production reloads; the before value was captured before source changes under the same server/browser setup.

### Five-minute request breakdown

| Endpoint | Before | After |
| --- | ---: | ---: |
| `/api/quo/live` | 22 | 10 |
| `/api/quo/stats` | 8 | 2 |
| `/api/readymode/stats` | 6 | 2 |
| `/api/team-agents` | 10 | 10 |
| One-time secondary endpoint requests | 12 | 0 |

Roster freshness remains at 30 seconds. Idle live-call feeds back off from 15 to 30 seconds, and idle aggregate feeds back off from 60 to 120 seconds. Polling pauses when the query is inactive, the document is hidden, the browser is offline, or the user is signed out.

## Production chunks

- Initial dashboard entry: 890.50 kB / 258.75 kB gzip
- Recharts shared chunk: 384.09 kB / 105.99 kB gzip
- Onboarding feature: 51.51 kB / 14.80 kB gzip
- Backend charts feature: 40.49 kB / 10.46 kB gzip
- CSV export parser: 19.78 kB / 7.37 kB gzip
- Samia feature: 16.32 kB / 4.73 kB gzip

Only the entry script loaded on the initial Retention view. Onboarding loaded its feature plus the shared chart chunk when selected. Samia loaded only after its launcher was clicked. CSV parsing loads only when an export is requested.

## Browser workflows and KPI comparisons

- Login: passed with the sanitized local admin.
- Retention: baseline and after both showed 11 agents; total calls, answered, missed, retains, cancels, and fixed values remained 0 for the local date fixture.
- Internal CS: rendered 7 agents and unchanged zero-valued local call/file KPIs.
- NSF: rendered its KPI and call table states.
- Ready-Mode Killers: rendered dialer/file KPIs and table states.
- Missed / No CB and callback review: rendered filters, totals, and empty states.
- Violations: rendered all five categories with unchanged local totals.
- Retention QA and live transfers: rendered KPI, review, manager-queue, export, and run controls.
- Onboarding: lazy-loaded and rendered report and team analytics states.
- Backend Statistics: rendered all six KPIs and export control.
- Phones: Quo Lines, PBX, and ReadyMode views rendered; PBX and ReadyMode tables/statuses remained available.
- Attendance: rendered 18 sanitized members, all date columns, filters, edit/view controls, and unchanged totals.
- Filters: Retention's Yesterday preset changed both dates and requested the matching Quo and ReadyMode date ranges.
- Admin: user management, agent roster, and blocked-number panels opened successfully.
- Samia: the UI opened after its click-triggered feature download; no external model request was made.
- Downloads: onboarding report and analytics endpoints returned authenticated HTTP 200 XLSX files with their existing filenames, MIME types, and ZIP signatures.
- Logout: returned to Login, removed the stored token, cleared the account cache, and made no background API requests during the signed-out observation.

Sanitized contract/KPI fixtures remained covered by the existing baseline suite. No formulas, API response contracts, permissions, labels, colors, layout, exports, or write workflows were intentionally changed.

## Environment limitations

- No real Google Sheets credentials or approved sheet ID/gid were provided, so a populated Google sheet could not be manually compared. The authenticated sheet route and its sanitized contract remain covered by existing tests.
- No live Quo/OpenPhone calls, populated PBX calls, ReadyMode agent rows, onboarding calls, violation events, QA reviews, or AI provider key existed in the disposable fixture. Those pages and their loading/empty/error/control states were verified, but non-zero live-provider values and actual AI responses were not exercised.
- The in-app browser did not expose a true background-tab visibility transition. Hidden/offline/inactive behavior is covered by the shared policy unit tests and React Query's disabled background intervals; signed-out behavior was additionally verified in the browser.

## Commands

Pre-change and final gates use:

```text
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run test:security
pnpm run test:baseline
pnpm run test:frontend-performance
pnpm run check:frontend-bundle
pnpm run test:performance
```

The repository has no lint script, so no lint command was available.
