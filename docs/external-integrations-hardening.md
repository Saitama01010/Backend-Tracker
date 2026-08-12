# External integrations hardening

Branch: `hardening/03-external-integrations`

Base: tested `hardening/02-authorization` commit `90645bd83fc88792a9d3fd2d83a34189703e4b5c`

Captured: 2026-07-15

## Compatibility and security contract

This phase keeps successful dashboard response shapes and KPI calculations intact while tightening the credentialed Quo/OpenPhone, PBX/VoS, ReadyMode, and Google Sheets boundaries. Missing authentication still returns 401; an authenticated user without the required role, permission, tab, team, agent, or approved spreadsheet source receives 403. Malformed or excessive dates and diagnostic inputs receive 400. These errors are not converted into empty arrays or zero totals.

No database schema, upstream mapping, approved spreadsheet content, KPI formula, export format, webhook, cron entry point, or production deployment was changed. Integration errors returned to clients are generic; full error objects remain server-side logs only. No secret, customer number, transcript, agent identity, or spreadsheet row was added to tests or this report.

Read ranges are capped at 1,096 days so the dashboard's existing 2024-to-current “All time” workflow still works. Manual Quo syncs are capped at 31 days. PBX callback reviews accept at most 90 days. Quo call authorization now occurs before pagination and database limiting, so an authorized page cannot be displaced by rows the user may not see.

## Integration route inventory and rules

All paths below are mounted under `/api` and remain default-private.

| Route | Authorization rule | Hardening and compatibility result |
| --- | --- | --- |
| `GET /quo/lines`, `/quo/all-lines`, `/quo/sync-state` | admin | Existing admin workflow retained; upstream failures are sanitized. |
| `GET /quo/line-stats` | admin | Strict ordered date range, 1,096-day cap, bounded line ID, unchanged successful shape. |
| `GET /quo/stats` | `view_metrics` plus a visible team metrics tab | Strict ordered/capped date range; existing team/agent scoping and KPI fields retained. |
| `GET /quo/live` | `view_metrics` or `view_attendance` | Existing scoped live-call response retained; upstream errors sanitized. |
| `GET /quo/calls` | `view_metrics`, visible requested team, and permitted agent | Team/date/pagination inputs validated; rows filtered for authorization before offset/limit; `{ data, total }` shape retained. `total` now means all authorized rows, not only authorized rows that happened to survive an earlier database page. |
| `POST /quo/sync` | admin | Existing frontend and Samia JSON-body callers retained; manual ranges capped at 31 days; background success shape retained. |
| `POST /vos/refresh` | admin | Manual PBX system refresh is no longer available to every Missed-tab user; automatic background reads remain unchanged. The frontend Refresh control is shown only to admins. |
| `GET /vos/stats`, `/vos/live` | visible metric team; metrics/attendance respectively | Existing team/agent scoping, dashboard values, and successful shapes retained; failures sanitized. |
| `GET /vos/missed-no-callback` | visible Missed / No CB tab | Existing team filtering and response shape retained and verified. |
| `GET /vos/missed-hourly` | `view_missed_tables` plus visible Missed / No CB tab | Strict real calendar date; report formula and shape unchanged. |
| `GET /vos/missed-daily` | `view_missed_tables` plus visible Missed / No CB tab | Existing 14-day aggregation and shape retained; failures sanitized. |
| `GET /vos/missed-breakdown` | `view_missed_tables` plus visible Missed / No CB tab | Strict real calendar date; customer-number rows are team-filtered before return and visible stats are recomputed. |
| `GET /vos/callback-review` | visible Callback Review tab | Requires both `from` and `to` or bounded `days`; maximum 90 days; customer-number rows are scoped before return. |
| `GET /vos/debug/calls` | admin | Existing fixed calls diagnostic retained; failures sanitized. |
| `GET /vos/debug/proxy` | admin | Exact upstream allowlist only: `/api/dashboard`, `/api/agents`, `/api/ring-groups`, `/api/calls?limit=1`. URLs, hosts, protocols, redirects-by-input, arbitrary paths, and arbitrary query strings are rejected. |
| `GET /readymode/stats` | `view_metrics` plus a visible team metrics tab | Both dates are required when filtering; strict 1,096-day range cap; existing three-source merge, per-agent values, totals, and response shape retained. |
| `GET /readymode/probe` | admin | Exact path allowlist only: `/`, `/supervisor/`, `/reporting/`, `/report/`; redirects are rejected and only status, JSON flag, and body length are returned. No URL, final redirect target, cookies, body, or preview is exposed. |
| `POST /readymode/upload` | admin or edit | Existing approved CSV upload workflow retained; parsing failures sanitized. |
| `POST /readymode/session/reset` | admin | Session-system control narrowed from admin/edit to admin; success shape unchanged. |
| `POST /nsf/readymode-queue` | admin Samia workflow | Queue creation is admin-only; errors sanitized. |
| `GET /nsf/readymode-queue`; queue completion routes | NSF-capable or unrestricted Missed / No CB user | Legitimate queue display and Done workflow retained; IDs must be positive safe integers. |
| `GET /sheet` | visible Backend Stats or visible team metrics tab, then existing row scope | Spreadsheet ID and decimal `gid` must match the server allowlist before any service-account request. Unapproved source is 403; malformed `gid` is 400; upstream and service-account details are not returned. |

## Approved Google Sheets sources

The default allowlist contains only the spreadsheet ID/gid pairs already referenced by the dashboard at the phase boundary:

| Spreadsheet ID | Approved gid values |
| --- | --- |
| `1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o` | `837339339` |
| `11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc` | `0`, `871007220`, `1018337469` |

Trusted additions can be supplied server-side through `GOOGLE_SHEETS_ADDITIONAL_SOURCES` using `spreadsheetId=gid|gid,spreadsheetId=gid`. Invalid configuration fails closed with a generic 500. Spreadsheet IDs are document locators already present in frontend source, not service-account credentials; no private key, client email, token, or sheet data is embedded.

## Before/after compatibility comparison

Two built servers ran simultaneously with background jobs disabled: phase 2 on port 8092 and phase 3 on port 8093. The same admin identity, configured database, and 2024-01-01 through 2026-07-15 range were used. Only aggregate counts and hashes were inspected.

| Projection | Phase 2 | Phase 3 | Result |
| --- | ---: | ---: | --- |
| Quo source rows | 152,743 | 152,743 | Equal |
| Quo agents | 109 | 109 | Equal |
| Quo total calls | 151,955 | 151,955 | Equal |
| Quo connected calls | 30,378 | 30,378 | Equal |
| Quo missed calls | 8,563 | 8,563 | Equal |
| PBX active calls | 26 | 26 | Equal |
| PBX total agents | 59 | 59 | Equal |
| PBX online / available agents | 14 / 13 | 14 / 13 | Equal |
| PBX total / inbound / outbound / missed today | 90 / 28 / 62 / 1 | 90 / 28 / 62 / 1 | Equal |
| Quo live calls | 1 | 1 | Equal |
| PBX live calls / statuses | 1 / 59 | 1 / 59 | Equal |
| Missed without callback | 56 | 56 | Equal |
| Missed hourly total | 13 | 13 | Equal |
| Missed 14-day daily total | 927 | 927 | Equal |
| Missed breakdown total / callback / connected | 17 / 12 / 3 | 17 / 12 / 3 | Equal |
| ReadyMode agents | 25 | 25 | Equal |
| ReadyMode dialed / connected | 25,895 / 25,895 | 25,895 / 25,895 | Equal |
| ReadyMode talk seconds | 1,782,450 | 1,782,450 | Equal |
| Approved service-account Sheet read | HTTP 502 | HTTP 502 | Same pre-existing missing-credential limitation |

The Sheets runtime could not return rows in either branch because the configured local environment does not contain working Google service-account reader credentials. Consequently, live row values could not be compared. The sanitized fixture tests verify the unchanged `{ headers, rows }` contract and row scoping, while new policy tests verify each existing approved ID/gid pair and reject unapproved pairs before a credentialed request.

## Manual and browser verification

- Logged-out Quo stats returned 401.
- An active ordinary user received 403 for Quo sync, PBX refresh, ReadyMode session reset, and ReadyMode queue creation.
- An arbitrary ReadyMode URL and arbitrary PBX proxy URL returned 400 without contacting the requested destination.
- An unapproved spreadsheet returned 403 and a malformed gid returned 400 before credential use.
- Malformed Quo and PBX dates, a range over 1,096 days, and a manual sync over 31 days returned 400.
- Legitimate admin Quo and ReadyMode statistics returned 200.
- Browser login and dashboard render succeeded. Phones navigation, Quo/PBX/ReadyMode tabs, PBX data cards, ReadyMode table, and admin Refresh controls rendered with no application crash or framework overlay.
- Browser console errors were limited to `/api/sheet` and the same missing-credentials 502; no 401 or other API route failed.
- The dashboard smoke suite verified login, Quo filters, PBX, attendance, onboarding, ReadyMode, violations, AI/Samia diagnostics, downloads, and admin pages. The Sheets row case was the only explicit skip.

One verifier attempt initially supplied an oversized Quo sync range as query parameters instead of the endpoint's existing JSON body. The handler correctly ignored unsupported query parameters and began its default 48-hour admin sync read. Logs show upstream call-fetch progress but no database-write or completion phase before the isolated server was stopped. The corrected JSON-body test returned 400. No upstream record, schema, or spreadsheet was modified.

## Automated tests added

`artifacts/api-server/src/security/externalIntegrations.test.ts` adds deterministic, sanitized coverage for:

- admin-only manual integration controls;
- strict, ordered, capped integration dates while retaining the current all-time range;
- authorization before pagination and bounded numeric controls;
- exact ReadyMode and PBX diagnostic path allowlists;
- exact default and trusted-additional spreadsheet ID/gid allowlists;
- static production wiring and the absence of ReadyMode body/cookie previews.

Existing authentication, authorization, API contract, KPI, attendance, onboarding, violations, downloads, and frontend token tests remain unchanged and pass.

## Commands and results

| Command or verification | Result |
| --- | --- |
| `pnpm.cmd install --frozen-lockfile` | Passed; 587 workspace packages linked. |
| Pre-change `pnpm.cmd run test:security` | Passed: frontend 5/5, API 19/19. |
| Pre-change `pnpm.cmd run test:baseline` | Passed: 5/5. |
| Pre-change `pnpm.cmd run typecheck` | Passed. |
| Focused exploit test before implementation | Failed 2/2 as intended, proving ordinary-user PBX refresh and missing integration policy wiring. |
| `pnpm.cmd --filter @workspace/api-server run test:security` | Passed: 24/24. |
| `pnpm.cmd run test:security` | Passed: frontend 5/5, API 24/24. |
| `pnpm.cmd run test` | Passed: 57/57. |
| `pnpm.cmd run test:baseline` | Passed: 5/5. |
| `pnpm.cmd run typecheck` | Passed. |
| `pnpm.cmd run build` | Passed for phase 2 and phase 3; existing sourcemap and large-chunk warnings only. |
| Phase-3 `pnpm.cmd run test:smoke` | Passed 12, failed 0, skipped 1 (Sheets credentials unavailable). |
| Dual-server aggregate comparison | All executable Quo, PBX, live, missed-report, and ReadyMode projections equal. |
| Live denial/validation matrix | All 15 checks returned their expected 200/400/401/403 status. |
| Browser verification | Passed via Playwright fallback; `agent-browser` CLI was unavailable. |
| `git diff --check` | Passed. |

The first attempt to run the temporary live verifier as root `pnpm exec tsx` failed because `tsx` is package-local; rerunning through `--filter @workspace/api-server exec tsx` passed. This was a command-routing issue, not an application failure.

## Existing and new failures

No existing automated check failed before modifications. The pre-existing runtime limitation is the absent Google service-account reader configuration, which returns 502 on both branches. Existing build warnings concern sourcemap lookup for UI components and the current bundle size; neither became an error.

No new application, test, typecheck, build, KPI, API-shape, download, or browser failure was found. The unavailable live Sheets row check is explicitly recorded rather than replaced with empty data.

## Files changed and local commits

Changed implementation and test files:

- `artifacts/agent-dashboard/src/App.tsx`
- `artifacts/api-server/src/lib/externalIntegrationPolicy.ts`
- `artifacts/api-server/src/routes/authorizationPolicy.ts`
- `artifacts/api-server/src/routes/nsfReadymode.ts`
- `artifacts/api-server/src/routes/quo.ts`
- `artifacts/api-server/src/routes/readymode.ts`
- `artifacts/api-server/src/routes/sheets.ts`
- `artifacts/api-server/src/routes/vos.ts`
- `artifacts/api-server/src/security/externalIntegrations.test.ts`
- `docs/external-integrations-hardening.md`

Local implementation commit: `1972e5b feat: harden privileged external integrations`

The documentation commit is recorded in the final handoff after it is created. The branch has not been pushed, merged, deployed, or applied to `main`.
