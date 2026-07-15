# Baseline regression inventory

Baseline branch: `hardening/00-baseline-regression`
Baseline source: `origin/main` at `95ae528e171b211745d54fe7a6d5e7ec0e1e5539`
Captured: 2026-07-15

This phase records and tests current behavior. It does not change production routes, UI components, formulas, database schemas, authentication, or data. Every checked-in fixture is synthetic and contains no real phone number, transcript, credential, token, cookie, API key, or production record.

## Workspace and commands

The repository is a pnpm 10.23 monorepo running Node 24 and TypeScript 5.9. The dashboard is React/Vite, the API is Express, and data access is PostgreSQL/Drizzle.

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Uses the checked-in lockfile. |
| API development server | `pnpm --filter @workspace/api-server run dev` | Builds, then starts the API on `PORT`; also serves the built dashboard. |
| Dashboard development server | `pnpm --filter @workspace/agent-dashboard run dev` | Vite, default port 3000, proxies `/api` to `API_PROXY_TARGET` or `PORT`. |
| Production build | `pnpm run build` | Builds API and dashboard. |
| Full workspace build | `pnpm run build:full` | Type-checks and builds every package with a build script. |
| Type checking | `pnpm run typecheck` | Type-checks libraries, artifacts, and scripts. |
| Existing + deterministic tests | `pnpm run test` | Requires database environment variables because existing tests import database-backed modules. |
| Deterministic baseline only | `pnpm run test:baseline` | No database, external service, credentials, or real data required. |
| Live read-only smoke suite | `pnpm run test:smoke` | Set `BASELINE_SMOKE_BASE_URL` and a password; optional Google Sheet ID/GID enables the Sheets subtest. |
| Read-only smoke server | `pnpm run baseline:serve` | Serves the real Express app and built dashboard on `BASELINE_SMOKE_PORT` (default 8085) without running startup seed/fixup routines. |
| Lint | Not configured | No root or workspace lint script/config was present at the baseline commit. |
| Integration/e2e | Not configured | No existing integration, Playwright, Cypress, or e2e script/config was present. The new live smoke suite supplies read-only integration coverage. |

For a fresh linked worktree that should reuse an existing private environment without copying it, the existing tests can be run with Node's environment-file option passed to `tsx`:

```powershell
pnpm --filter @workspace/api-server exec tsx --env-file="C:\path\to\existing\.env" --test src/lib/anthropic-features.test.ts src/lib/dashboard-actions.test.ts src/baseline/regression.test.ts
```

No migration, database push, import, sync, refresh, upload, mutation, or administrative write is part of baseline verification.

## Pre-modification check results

These results were recorded after dependency installation and before any tracked file was edited:

| Check | Baseline result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; 587 lockfile-resolved packages installed. |
| `pnpm run test` in a fresh worktree without `.env` | Failed: 27 passed, 5 failed. All 5 failures came from `DATABASE_URL or OLD_DATABASE_URL must be set`; no assertion regression was observed. |
| Existing API tests with the existing environment explicitly loaded | Passed: 52/52. |
| `pnpm run typecheck` | Passed. |
| `pnpm run build` | Passed. Vite reported existing sourcemap-location and >500 kB chunk warnings. |
| `pnpm run build:full` | Passed, including mockup sandbox, API, and dashboard builds. Same existing Vite warnings. |

The default test-script environment dependency is a pre-existing baseline failure. It is not hidden or converted into an empty-data success.

## User-visible workflow inventory

The application is a single dashboard shell guarded by the login screen. Access is role, permission, team, and allowed-tab dependent.

- Login, session restoration through `/api/auth/me`, sign out, theme selection.
- Dashboard views: Backend Statistics, Metrics, Phone Systems (admin), and Attendance.
- Metrics tabs: Retention, Internal CS, NSF, Ready-Mode Killers, Missed / No Callback, Callback Review, Violations, Retention QA, and Onboarding.
- Phone Systems sub-tabs: Quo Lines, PBX, and ReadyMode.
- Filters: date presets/ranges, team, department, agent, line, day, status, and missed-call modes where supported.
- Google Sheets-backed submission/status tables for Retention, NSF, CS, Ready-Mode Killers, and related IDP workflows.
- Onboarding analytics and report workbooks.
- QA statistics, reviews, manager queue, run status, and download.
- Attendance month/department/member grid and privileged edit/member-management workflows.
- Admin panels: users, agent roster, blocked numbers, ReadyMode CSV upload.
- Samia admin chat, history, user history, number lookup/call analysis, and diagnostics.
- Export/download workflows for onboarding report, onboarding analytics, QA, and live transfers.

The baseline tests intentionally exercise only read operations and login. Mutating operations remain inventoried but are not invoked against the existing database.

## API inventory

All paths below are mounted under `/api`.

| Area | Routes |
| --- | --- |
| Health/auth | `GET /healthz`; `POST /auth/login`; `GET /auth/me` |
| Quo/OpenPhone | `GET /quo/lines`; `GET /quo/all-lines`; `GET /quo/line-stats`; `GET /quo/stats`; `POST /quo/sync`; `GET /quo/sync-state`; `GET /quo/live`; `GET /quo/calls`; `POST /quo/webhook`; `POST /openphone/webhook` |
| PBX/VoS | `POST /vos/refresh`; `GET /vos/stats`; `GET /vos/missed-no-callback`; `GET /vos/missed-hourly`; `GET /vos/missed-daily`; `GET /vos/missed-breakdown`; `GET /vos/callback-review`; `GET /vos/live`; diagnostic `GET /vos/debug/calls`; diagnostic `GET /vos/debug/proxy` |
| Attendance | `GET /attendance`; `POST /attendance/members`; `PATCH /attendance/members/:id`; `PUT /attendance/record`; `POST /attendance/import`; `GET /attendance/call-logs`; `POST /attendance/set`; `POST /attendance/auto-mark`; `GET /attendance/agent-contacts` |
| Sheets | `GET /sheet`; legacy `GET /csv-proxy` |
| ReadyMode | `GET /readymode/stats`; `GET /readymode/probe`; `POST /readymode/upload`; `POST /readymode/session/reset`; NSF queue `GET/POST /nsf/readymode-queue`; `POST /nsf/readymode-queue/:id/done`; `POST /nsf/readymode-queue/done-by-number` |
| Onboarding | `POST /ob-report/refresh`; `GET /ob-report/status`; `GET /ob-report/download`; `POST /ob-report/import`; `GET /ob-analytics`; `GET /ob-analytics/download` |
| Violations | `GET /violations`; `POST /violations/verify`; `DELETE /violations/verify`; `GET /violations/verified` |
| QA/AI | `POST /qa/evaluate`; `POST /qa/biweekly-run`; `GET /qa/biweekly-run`; `POST /qa/process`; `GET /qa/runs/latest`; `POST /qa/assign-weekly`; `GET /qa/stats`; `GET /qa/download`; `GET /qa/reviews`; `GET /qa/reviews/:id`; `GET /qa/tasks`; `POST /qa/tasks/:id/resolve`; `GET /qa/agents` |
| Samia | `GET /samia/history`; `GET /samia/users`; `GET /samia/history/:userId`; `GET /samia/number-lookup`; `GET /samia/call-analysis`; `GET /samia/diagnostics`; `POST /samia/chat` |
| Live transfers | `GET /live-transfers/status`; `POST /live-transfers/refresh`; `GET /live-transfers/download` |
| Admin/reference data | users `GET/POST /users`, `PATCH/DELETE /users/:id`; roster `GET/POST /team-agents`, `PATCH/DELETE /team-agents/:id`; blocked numbers `GET/POST /blocked-numbers`, `DELETE /blocked-numbers/:number`; breaks `GET /breaks`, `POST /breaks/start`, `POST /breaks/end`, `POST /breaks/log`, `DELETE /breaks/:id` |

## Important response contracts

The executable schemas are in `artifacts/api-server/src/baseline/contracts.ts`. They require the fields the dashboard consumes while permitting additive response fields.

| Endpoint | Pinned top-level response shape |
| --- | --- |
| `POST /auth/login`, `GET /auth/me` | `{ token, user: { id, username, role, permissions, teamAccess?, allowedTabs?, allowedAgents?, allowedSubTabs?, lockToToday?, hideBackendStats? } }` |
| `GET /quo/stats` | `{ teamStats, allAgentStats, lineInbound, agentLastCall, allAgentLastCall, totalRows, lastSyncedAt, isSyncing }`; each agent/day carries total calls, talk seconds, inbound/outbound, answered/missed/voicemail/brief voicemail, and unique contacts. |
| `GET /vos/stats` | `{ dashboard, agents, ringGroups, callHistory?, callHistoryFetchedAt?, ringGroupMissed? }`; dashboard pins live/total/online/available agents, daily total/inbound/outbound/missed calls, average duration, per-agent calls, live calls, and statuses. |
| `GET /attendance` | `{ members, records, timezone }`; members retain shift/department/active fields and records retain date/status/note/coaching. |
| `GET /sheet` | `{ headers: string[], rows: Record<string,string>[] }` |
| `GET /readymode/stats` | `{ agents, totals, updatedAt, raw? }`; agents retain dialed, connected, talk time, average talk, and connect rate. |
| `GET /ob-report/status` | `{ running, progressDone, progressTotal, lastRunAt, lastError, totalCalls, classified, typeCounts, taxYes, taxNo }` |
| `GET /ob-analytics` | `{ meta, kpis, agents, hourly, peaks, cassie, insights }` with call, response, missed, talk, gap, first-ring, and onboarding metrics. |
| `GET /violations` | `{ lateLogin, availabilityGaps, missedWhileAvail, verifiedKeys }` |
| `GET /samia/diagnostics` | `{ anthropicKeyExists, samiaModel, qaModel, liveTransferModel, aiRequestUsageExists, qaBiweeklyRunsExists, rateLimits, deploymentEnvironment }`; no secret value is returned. |
| `GET /users` | Array of user metadata with parsed permissions and allowlists; password hashes are not part of the selected response. |
| `GET /team-agents` | Array of `{ id, name, team, active, ...optional roster metadata }`. |
| Excel downloads | HTTP 200, spreadsheet MIME type, attachment disposition, and XLSX ZIP signature; contents are never snapshotted. |

## Regression coverage

Deterministic tests use synthetic agents (`Agent Alpha`, `Agent Beta`, and similar placeholders). They pin:

- Total, connected, and missed calls.
- Team totals and agent totals.
- Attendance record totals by status.
- Onboarding and connection totals.
- Late-login, availability-gap, missed-call, and combined violation totals.
- Important route declarations and the source expressions that currently increment Quo total/answered/missed counts and calculate ReadyMode totals.
- Dashboard main tabs and Phone Systems sub-tabs.
- Sanitized response contracts for login, Quo/OpenPhone, PBX, attendance, Google Sheets, ReadyMode, onboarding, violations, Samia diagnostics, users, and roster data.

The live smoke suite checks application HTML, login, identity refresh, Quo/OpenPhone data and filters, PBX data, attendance, optional Google Sheets data, onboarding reports/analytics, ReadyMode, violations, QA/Samia diagnostics, Excel downloads, and admin reference data. It validates shapes and non-empty prerequisites without writing response payloads to disk or snapshots.

## Live smoke environment

```text
BASELINE_SMOKE_BASE_URL=http://127.0.0.1:8080
BASELINE_SMOKE_USERNAME=admin                 # optional; defaults to admin
BASELINE_SMOKE_PASSWORD=<private password>    # or DASHBOARD_PASSWORD
BASELINE_SMOKE_SHEET_ID=<private sheet id>    # optional; enables Sheets smoke
BASELINE_SMOKE_SHEET_GID=<numeric gid>        # optional; enables Sheets smoke
```

Never place those values in source control or command output. The smoke suite does not invoke sync, refresh, import, upload, edit, create, delete, verification, QA evaluation, or Samia chat/model-generation endpoints.

## Post-change verification

The baseline additions were verified without changing application behavior or writing production data:

| Check | Result |
| --- | --- |
| `pnpm run test:baseline` | Passed: 5/5 deterministic contract, KPI, route, and source-pin tests. |
| Existing API tests plus regression tests with the existing environment loaded | Passed: 57/57. |
| `pnpm run typecheck` | Passed. |
| `pnpm run build` | Passed with the same pre-existing Vite sourcemap-location and large-chunk warnings. |
| Read-only live smoke suite | Passed: 12; failed: 0; skipped: 1 Google Sheets check. |

Browser verification confirmed that login and session restoration work; the dashboard renders populated KPI cards, charts, and tables; Today/Yesterday filters change and restore the displayed data; Quo, PBX, ReadyMode, Attendance, Violations, Onboarding, and Admin Users views load; and the Samia panel opens without sending a model request. The browser harness did not emit a download event for the application's Blob-based download handler, so download correctness was verified at the HTTP layer instead: both onboarding workbook endpoints returned non-empty XLSX attachments with the expected MIME type and ZIP signature.

Google Sheets could not be verified in this local environment because `GOOGLE_SA_CLIENT_EMAIL` and `GOOGLE_SA_PRIVATE_KEY` are not configured. Both current and legacy Sheets endpoints consequently return their existing 502 configuration error. This limitation was recorded rather than masked with empty rows or mock customer data.
