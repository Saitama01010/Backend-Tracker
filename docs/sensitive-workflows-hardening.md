# Sensitive workflow hardening report

## Scope and non-regression result

- Branch: `hardening/04-sensitive-workflows`
- Base: `hardening/03-external-integrations` at `d99d8dd9e9962afdc43154a9a3d3b3d65755aecb`
- No branch was pushed, merged, force-pushed, or deployed. `main` was not checked out or modified.
- Successful response objects, KPI formulas, workbook filenames, worksheet formats, and columns were preserved.
- The only client controls hidden are operations the server now reserves for administrators: onboarding/live-transfer AI refresh and verification deletion.

## Route-to-permission matrix

| Route | Permission | Scope and validation | Coverage |
| --- | --- | --- | --- |
| `GET /api/attendance` | `view_attendance` | Team, allowed-agent, strict/capped date range; inactive members additionally require `manage_members` | Policy, contract, live read, phase-3 comparison |
| `POST /api/attendance/members` | `manage_members` | Requested department and agent must be allowed | Policy and unauthorized live request |
| `PATCH /api/attendance/members/:id` | `manage_members` | Existing and final department/agent identities must be allowed; covers edits and deactivation | Policy and type checks |
| `PUT /api/attendance/record` | `edit_attendance` | Resolved active member, department, agent, and strict date | Policy and existing deterministic attendance mutation tests |
| `POST /api/attendance/set` | `edit_attendance` | Strict dates, bulk confirmation, resolved member, department, and agent; ambiguous identities fail without disclosing matches | Policy and existing deterministic attendance mutation tests |
| `POST /api/attendance/auto-mark` | `edit_attendance` | Strict date; only authorized team/agent members are processed | Policy and contract tests |
| `POST /api/attendance/import` | `manage_members` | Only users without team or agent restrictions; both approved sources must succeed and validate before writes | Policy, unauthorized live request, source-failure regression contract |
| `GET /api/attendance/call-logs` | `view_attendance` | Strict date; returned agents are team/agent scoped | Policy and live smoke |
| `GET /api/attendance/agent-contacts` | `view_attendance` | Strict date, bounded escaped agent lookup, team/agent filter before response | Policy and security contract |
| `GET /api/ob-report/status` | `view_metrics` plus onboarding tab | Strict optional ordered/capped date range | Policy, live smoke, phase-3 comparison |
| `GET /api/ob-report/download` | `view_metrics` plus onboarding tab | Same range as report; private/no-store workbook | Policy and authenticated download |
| `POST /api/ob-report/refresh` | Admin | AI classification and upstream sync control | Policy and unauthorized live request |
| `POST /api/ob-report/import` | `OB_IMPORT_SECRET` | Existing server-to-server importer remains independently authenticated and public to browser auth middleware | Public-route security suite |
| `GET /api/ob-analytics` | `view_metrics` plus onboarding tab | Strict optional ordered/capped date range | Policy, live smoke, phase-3 comparison |
| `GET /api/ob-analytics/download` | `view_metrics` plus onboarding tab | Same analytics range; private/no-store workbook | Policy and authenticated download |
| `GET /api/live-transfers/status` | `view_metrics` plus onboarding tab | Strict optional ordered/capped date range | Policy and phase-3 comparison |
| `GET /api/live-transfers/download` | `view_metrics` plus onboarding tab | Same report range; private/no-store workbook | Policy and authenticated download |
| `POST /api/live-transfers/refresh` | Admin | AI classification control | Policy and unauthorized live request |
| `GET /api/violations` | `view_metrics` plus violations tab | Strict/capped dates; members, aliases, phone-derived rows, and verification keys are team/agent scoped | Policy, live smoke, phase-3 comparison |
| `POST /api/violations/verify` | `view_metrics` plus violations tab | Strict type/date/details, team/agent/date scope; actor always comes from `req.user.username` | Policy and deterministic forged-actor test |
| `DELETE /api/violations/verify` | Admin | Bounded key; destructive correction | Policy and unauthorized live request |
| `GET /api/violations/verified` | `view_metrics` plus violations tab | Team/agent scoped before response | Policy and contract tests |
| `GET /api/qa/stats`, `/reviews`, `/tasks`, `/agents` | `view_metrics` plus QA tab | Requested department must be allowed; allowed-agent filtering occurs before metrics or pagination | Policy, live smoke, phase-3 comparison |
| `GET /api/qa/reviews/:id` | `view_metrics` plus QA tab | Final review department and agent are checked before return | Type and security contract |
| `GET /api/qa/download` | `view_metrics` plus QA tab | Same department/agent/date basis as the QA screen; filtering before workbook generation; private/no-store | Policy and authenticated download |
| `POST /api/qa/tasks/:id/resolve` | Admin | Authenticated username is recorded as the resolver | Existing admin policy and static regression contract |
| `/api/users` and `/api/users/:id` writes | Admin | Existing member/user administration policy retained | Authorization suite |
| `/api/team-agents` writes | Admin | Existing roster configuration policy retained | Authorization suite |
| `/api/blocked-numbers` writes | Admin or edit role | Existing documented backend workflow retained | Authorization suite |
| `/api/breaks` writes | Admin or edit role | Existing documented attendance workflow retained | Authorization suite |

Missing/invalid authentication remains `401`. Authenticated users without a route, team, agent, tab, date, or administrative grant receive `403`. Malformed inputs receive `400`; upstream attendance-import failures return `502` rather than a false success containing zero totals.

## Export verification

The candidate server returned an XLSX ZIP response with the existing filename and `Cache-Control: private, no-store, max-age=0` for every export:

| Export | Filename | Result |
| --- | --- | --- |
| Onboarding line report | `Onboarding_Line_Report_2026-07-15.xlsx` | 200, XLSX, private/no-store |
| Onboarding analytics | `Onboarding_Team_Analysis.xlsx` | 200, XLSX, private/no-store |
| Live transfers | `Live_Transfers.xlsx` | 200, XLSX, private/no-store |
| QA reviews | `QA_Reviews.xlsx` | 200, XLSX, private/no-store |

The live smoke suite also checked the onboarding workbooks' non-empty XLSX signature. Google Sheets smoke remained skipped because `BASELINE_SMOKE_SHEET_ID` and `BASELINE_SMOKE_SHEET_GID` were not configured; the existing phase-3 Sheets allowlist/security tests still passed.

## Before/after KPI comparison

Two production builds, one at phase 3 and one with this phase, ran concurrently against the same database with background jobs disabled. Read-only requests used the same Los Angeles date (`2026-07-15`). Only the analytics `generatedAt` timestamp was normalized.

| Workflow | Phase 3 vs phase 4 | Sanitized observed totals |
| --- | --- | --- |
| Attendance | Exact response equality | 30 members, 13 records |
| Violations | Exact response equality | 3 late, 12 gap rows, 8 missed rows, 9 verified keys |
| Onboarding status | Exact response equality | 20 calls, 0 classified in the selected range |
| Onboarding analytics | Exact response equality after generated timestamp normalization | 20 calls |
| Live transfers | Exact response equality | 0 in the selected range |
| QA statistics | Exact response equality | 21 reviewed |

These are transient local verification counts, not fixture or customer data, and were not copied into tests.

## Workflows verified

- Real login and authenticated identity.
- Dashboard HTML and browser login UI render; no Vite/Next error overlay and zero browser console errors.
- Quo/OpenPhone and PBX statistics, filters, attendance reads, onboarding reports and analytics, ReadyMode, violations, QA and Samia diagnostics, admin users, and roster reads.
- Authenticated onboarding, live-transfer, and QA downloads.
- Logged-out and invalid-token attendance calls return `401`.
- A real non-admin receives `403` for member creation, attendance import, onboarding refresh, live-transfer refresh, and verification deletion. These rejected requests execute before mutation.
- Malformed attendance and violation dates return `400` instead of widening a query.
- Authorized mutation eligibility is covered by the route-policy tests and the existing deterministic attendance action/service tests. Live create/update/delete/import/refresh operations were deliberately not executed against the shared database because that would alter production-backed records or trigger privileged integrations.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm run typecheck` | Passed across libraries, API, dashboard, scripts, and mockup sandbox |
| `pnpm run test:security` | 34 passed (5 frontend, 29 API) |
| `pnpm run test:baseline` | 5 passed |
| `pnpm run test` with private environment | 57 passed |
| `pnpm run build` | Passed; pre-existing source-map and large-chunk warnings remain |
| `pnpm run test:smoke` against phase 4 | 12 passed, 1 skipped (Google Sheets test source not configured) |
| `scripts/verify-sensitive-workflows.ps1` | Exact phase-3/phase-4 comparisons, negative auth checks, and four authenticated exports passed |

The first full test run without loading the private environment had five pre-existing environment failures because `DATABASE_URL` was absent; it had no assertion regression. Loading the existing private environment produced 57/57 passing tests. The initial focused security contract intentionally failed on the pre-fix refresh, deletion, actor, date, import, and cache behavior; it passes after the changes.

## Intentionally restricted behavior and unresolved ambiguity

- Onboarding and live-transfer AI/sync refreshes are now admin-only. Report/analytics reads and downloads remain available to existing onboarding viewers.
- Removing a persisted violation verification is now an admin correction. Existing violations viewers can still create verification records.
- Attendance imports fail before database writes if either approved spreadsheet cannot be fetched or parsed; failures are no longer reported as a successful zero-result import.
- `%`, `_`, and `\` in attendance agent searches are treated literally rather than as caller-controlled SQL pattern wildcards.
- Current active-user evidence has no non-admin member managers/editors and no allowed-agent users. The existing named permissions remain supported rather than being silently converted to admin-only. A future user with `manage_members` may manage members only within their team/agent scope and may import only when unrestricted.
- Existing admin-or-edit policies for blocked-number and break writes were retained because they are established application behavior; this phase did not invent a narrower role.
- QA alias matching uses the trusted team-agent directory and falls back to exact normalized allowed-agent matching when an identity is absent from the directory.
