# Phase 1 current behavior map

Baseline: `origin/main` at `542201004c51a5af8c457e0015a71b733c9a2e04`, captured 2026-08-16.

This document describes the application as it currently works. It is not a redesign or a statement that the behavior is ideal. The executable companion is `phase-1-current-behavior-map.json`; the business-contract suite validates its page and endpoint references against production source.

## Runtime boundaries

- The browser is a React/Vite single-page dashboard in `artifacts/agent-dashboard/src/App.tsx`, with lazy modules for Onboarding, Backend Statistics charts, and Samia.
- Express is assembled in `artifacts/api-server/src/app.ts`. All feature routers are mounted below `/api` in `routes/index.ts`.
- Private routes first pass default authentication, then the centralized method/path authorization policy, then any route-local permission middleware.
- PostgreSQL/Drizzle is the durable business store. QUO, PBX, ReadyMode, Google Sheets, and Anthropic are external sources.
- Business calendar dates use `America/Los_Angeles`. Attendance preserves the existing Cairo compatibility behavior via `Africa/Cairo` and the configured cutover.

## Dashboard-to-data map

| Page | Access and restrictions | Read endpoints | Tables and external inputs | Exports |
| --- | --- | --- | --- | --- |
| Login | Public login/password-upgrade; refresh cookie; authenticated `/auth/me` | `/auth/me` after login | `portal_users`, `auth_sessions`, canonical grants and roster | None |
| Backend Statistics | Visible `backend-stats` grant | `/team-agents`, `/sheet` | `team_agents`; Google Sheet Retained, Fixed, IDP Handled, and IDP Handled Retained tabs | Client CSV |
| Retention | `view_metrics`, Retention tab, optional team/agent/subtab and today lock | `/team-agents`, `/sheet`, `/quo/stats`, `/quo/calls`, `/quo/live`, `/quo/live/refresh`, `/vos/stats`, `/vos/live`, `/readymode/stats` | `team_agents`, `phone_calls`, `readymode_uploads`, PBX snapshot; all five file/call sources | By Files and raw submissions CSV |
| Internal CS | Same controls for CS | Same shared metric/phone endpoints | Same shared sources, CS-scoped by roster and authorization | By Files and raw submissions CSV |
| NSF | Same controls for NSF | Same shared metric/phone endpoints | Same shared sources, NSF-scoped by roster and authorization | By Files and raw submissions CSV |
| Ready-Mode Killers | `view_metrics`, RMK tab and optional agent/subtab scope | `/team-agents`, `/sheet`, `/quo/stats`, `/quo/live`, `/quo/live/refresh`, `/vos/stats`, `/vos/live`, `/readymode/stats` | Same shared sources, Killers roster routing | By Files and raw submissions CSV |
| Missed / No Callback | Tab grant; manager tables need `view_missed_tables`; NSF queue needs full NSF access | `/vos/missed-no-callback`, `/vos/missed-daily`, `/vos/missed-hourly`, `/vos/missed-breakdown`, `/nsf/readymode-queue`; privileged refresh/completion routes | `phone_calls`, `pbx_missed_calls`, `nsf_readymode_queue`, durable PBX snapshot | None |
| Callback Review | Callback Review tab | `/vos/callback-review` | `phone_calls`, `pbx_missed_calls`, durable PBX mappings | None |
| Violations | Violations tab; only admin can remove a verification | `/violations`, `/violations/verified`; verify mutations | attendance, breaks, QUO calls, PBX missed calls, verification rows, shared PBX spans | Two client CSV detail exports |
| Retention QA | QA tab; process, latest-run, and resolution operations are admin | `/qa/stats`, `/qa/reviews`, `/qa/reviews/:id`, `/qa/tasks`, `/qa/runs/latest`, `/qa/download` and admin mutations | QUO calls/transcripts, QA reviews/tasks/runs, AI reservation/usage tables, roster | QA XLSX |
| Onboarding | Explicit privileged global tab grant; refresh admin; canonical non-admin live-transfer reads denied | `/ob-report/status`, `/ob-analytics`, `/live-transfers/status`, their refresh and download routes | QUO calls/transcripts; onboarding and live-transfer classifications/state; durable jobs | Three XLSX downloads |
| Phones / Quo Lines | Admin | `/quo/all-lines`, `/quo/line-stats`, `/quo/live`, `/quo/live/refresh` | QUO API plus `phone_calls` | None |
| Phones / PBX | Admin | `/vos/stats`, `/vos/live`, privileged `/vos/refresh` | VoS/PBX authenticated JSON API, QUO directory, PBX durable snapshot | None |
| Phones / ReadyMode | Admin | `/readymode/stats`, `/readymode/probe`, `/readymode/session/reset` | attached/configured/uploaded ReadyMode CSV and retained HTML probe client | None |
| Attendance | `view_attendance`; record writes need `edit_attendance`; member/import work needs `manage_members` | `/attendance` and its record/member/import/auto-mark routes | attendance tables, roster, QUO calls, shared PBX call history | None |
| Manage Users | Admin | `/users`, `/users/:id`, `/team-agents` | users, sessions, canonical team/tab grants, roster | None |
| Agent Roster | Scoped read; admin mutations | `/team-agents`, `/team-agents/:id` | `team_agents`, referenced users | None |
| Blocked Numbers | Admin read; current admin/edit write gate | `/blocked-numbers`, `/blocked-numbers/:number` | `blocked_numbers` and its five-minute invalidated cache | None |
| Samia | Admin plus capability-specific gates | `/samia/users`, `/samia/history`, `/samia/history/:userId`, `/samia/chat` | messages, users, calls, PBX missed calls, AI controls/reservations, action audit; Anthropic and explicit QUO transcript lookup | None |

The Retention, CS, NSF, and RMK pages each expose the current By Call, By Files, and By Day presentations when permitted. They deliberately share server payloads; `allowedSubTabs` changes presentation, not the underlying shared API contract.

## External-source formats and current interpretation

### QUO / OpenPhone

- Inputs are paginated REST JSON and signed webhook JSON.
- The sync mapper preserves the existing line/team classification, user/alias resolution, outgoing voicemail thresholds, incoming no-answer handling, participant handling, and provider timestamps.
- A duplicate provider call ID reaches the current PostgreSQL upsert boundary as the same primary key. Phase 1 does not invent a new pre-upsert deduplication rule.
- Characterization fixture: `artifacts/api-server/src/businessContracts/fixtures/quo/api-pages.json`.

### PBX / VoS

- `vos.ts` establishes the provider web session with `POST /api/auth/login`, retains the returned cookie, retries once with a renewed cookie after a 401, and consumes JSON from `/api/dashboard`, `/api/agents`, `/api/ring-groups`, and paginated `/api/calls`.
- Dashboard PBX statistics and live values therefore come from the authenticated JSON API. The production PBX path does not parse an HTML report into dashboard values.
- The adapter keeps process-local login cookies and mapping accelerators, but the authoritative cross-instance PBX snapshot is stored in `durable_runtime_state`.
- Name matching currently includes an explicit two-entry PBX display-alias table, a separate directional sheet-to-PBX alias table, and roster-derived matching elsewhere in the browser. The tests pin the exact tables by digest without copying employee identities into fixtures or reports.
- Both JSON and sanitized HTML evidence fixtures are present under `fixtures/pbx`. The HTML fixture covers inconsistent names, an empty report, and a missing optional cell without creating a new production ingestion path.

### ReadyMode

- Statistics merge the first matching attached `Agent_report*.csv`, the configured Google CSV, persisted uploads, and date filters. This is the production statistics path.
- Required CSV fields are Name/Agent plus Logged calls/Calls. Rows without an agent, summary/total rows, and rows without either a parsed date or caller fallback date are skipped.
- Repeated rows remain repeated at parse time; database upload uniqueness and current conflict behavior remain the downstream boundary.
- Separately, the code retains a best-effort HTML table parser and approved `/readymode/probe` diagnostic client. The probe/parser does not supply the `/readymode/stats` CSV pipeline.
- Fixtures cover valid, duplicate, empty, invalid-header, multiple-agent, multiple-date, quoted/duration, fallback-date, and HTML cases under `fixtures/readymode`.

### Google Sheet 1

The dashboard consumes three logical tabs through the server-only Sheets v4 route:

- IDP Handled: every routed row is classified `IDP-Handled`.
- Retained: current keyword precedence and structured status fallback apply.
- Fixed/backend submissions: current team loaders interpret their existing `File Status` rules.

The server discovers a likely header within the first ten rows, preserves unnamed/trailing columns as `__colN`, drops only fully empty rows, and can return compact `rows-v1`. Duplicate-looking rows are not automatically collapsed.

### Google Sheet 2

- Current aliases for this single source/tab are the configuration key `idpCancelRetained`, provider title `IDP Cancel Retained`, client tab/status mode `idp-cancel-retained`, internal row marker `IDP-Cancel-Retained`, and the mission/fixture label `IDP Handled Retained`.
- Every valid row routed to Retention is forced to `Retained`, including a row whose note text contains “cancelled.” Keyword reclassification is intentionally not applied to this tab.
- The exact contribution is covered by the source block pin, the aggregate invariant, the browser fixture flow, and `fixtures/sheets/google-sheet-2.json`.

## Status and counting invariants

- `Retained`, `Cancelled`, `IDP-Handled`, and `Fixed` are seeded as separate display categories for Retention/NSF/CS aggregation.
- Duplicate-looking sheet rows are separate current rows.
- `IDP-Handled` contributes to the established retention-rate numerator through `isRetainedStatus`, but is excluded from the pure retained daily/monthly tiles through `isPureRetainedStatus`.
- Sheet 2 rows are pure `Retained`, so they contribute to retained category counts and the rate numerator.
- QUO status mapping and PBX/ReadyMode call placement remain independent inputs to the By Call view; ReadyMode adds dialed calls/talk time under current alias rules.
- API and export parity is executable for the onboarding analytics workbook. Browser tests cover the client CSV and server XLSX download paths.

## Roles, capabilities, and scopes

The legacy roles are `admin`, `edit`, and `view`. The stored permissions are:

- `view_metrics`
- `view_attendance`
- `edit_attendance`
- `manage_members`
- `view_missed_tables`

Response and UI scope may also depend on `teamAccess`, `allowedTabs`, `allowedAgents`, `allowedSubTabs`, `lockToToday`, and `hideBackendStats`. Canonical accounts additionally use an access role, immutable roster self identity, primary team, full-team grants, and privileged tab grants.

The centralized route policy is the controlling API map. Unknown private routes default to admin. Route-local middleware is an additional gate. Existing deterministic security tests cover admin, ordinary authenticated, limited team, limited agent, limited tab, today-only, canonical Agent, canonical Manager, deactivated, and logged-out behavior.

## Date behavior

- Dashboard calendar filters and “today” use `America/Los_Angeles` explicitly.
- QUO database bounds and current sheet date conversion retain their existing LA behavior.
- Attendance shift compatibility retains its Cairo rules and configured correctness cutover.
- `lockToToday` requires explicit current-day ranges for locked read routes and rejects historical/future date, break, and attendance mutation values.
- Locked routes are QUO stats/calls, ReadyMode stats, Attendance, Violations, Callback Review, ranged QA reads/download, Onboarding report/analytics, Live Transfers, and Breaks.
- QA UI currently fixes its report range to today and `dateBasis=evaluated`.
- Callback Review presets are Today, current Monday-Sunday week, current month, and custom range.
- Onboarding accepts all-time, month, day, or ordered custom ranges.

## Route/table/source inventory

| Route owner | Durable tables used directly or through its traced service | External source |
| --- | --- | --- |
| `auth.ts` | users, sessions, roster and canonical grants | None |
| `quo.ts` + sync | phone calls/sync state, blocklist, roster, durable state | QUO REST |
| `quoWebhook.ts` | webhook inbox, phone calls, durable state | Signed QUO events and directory lookups |
| `vos.ts` | phone calls, PBX missed calls, NSF queue, roster, durable state | PBX JSON API and QUO number directory |
| `readymode.ts` | ReadyMode uploads, roster | attached/configured CSV and approved HTML probe |
| `sheets.ts` | roster for row authorization | Google Sheets v4 |
| `attendance.ts` | members, records, phone calls, roster | configured attendance CSV and PBX snapshot |
| `breaks.ts` | agent breaks, roster | None |
| `violations.ts` | attendance, breaks, calls, PBX missed, verifications, roster | None beyond shared provider snapshots |
| `nsfReadymode.ts` | NSF queue, phone calls | None |
| onboarding report | calls, classifications, report state, background jobs | QUO transcripts |
| onboarding analytics | calls, classifications | None |
| live transfers | calls, classifications, state, background jobs | QUO transcripts |
| `qa.ts` | calls, reviews, tasks, runs, roster, AI controls/reservations, jobs | QUO transcripts and Anthropic |
| `samia.ts` | messages, users, calls, PBX missed, AI controls/reservations, audit | Anthropic and explicit QUO transcript lookup |
| `users.ts` | users, sessions, canonical grants, roster | None |
| `teamAgents.ts` | roster and referenced users | None |
| `blockedNumbers.ts` | blocked numbers | None |
| `backgroundJobs.ts` | background jobs and durable runtime state | None |

The complete method/path list for each owner is in the JSON companion. The current production routers declare 99 Express endpoints, including public/session/webhook/cron routes and private reads/mutations.

## Background jobs

The durable scheduler uses PostgreSQL leases and deterministic idempotency keys. Current job families are:

| Work | Key/cadence | Existing handler behavior |
| --- | --- | --- |
| QUO live + PBX refresh | UTC minute; intended every minute | Refreshes provider state and durable snapshots |
| QUO incremental sync | UTC 15-minute window | Applies the established mapping/upsert path |
| Biweekly QA eligibility | UTC day at 09:00 | Runs the existing rolling 14-day selection |
| PBX backfill | UTC day at 09:00 | Rebuilds historical PBX data idempotently |
| Weekly QA assignment | Monday UTC day at 09:00 | Uses existing lowest/random rules |
| Onboarding report | request idempotency key | Classifies transcripts and records progress |
| Live-transfer refresh | request idempotency key | Classifies transfers and records progress |

## Imports and writes

- QUO sync/webhook writes `phone_calls`, sync state, and the webhook inbox.
- PBX refresh writes missed calls and durable snapshots.
- ReadyMode upload accepts CSV plus filename and explicit date and writes `readymode_uploads`.
- Attendance import reads the configured CSV and writes members/records under `manage_members`.
- Onboarding classification import is protected independently by `OB_IMPORT_SECRET`.
- Browser smoke tests do not invoke these destructive/mutating workflows. Parser and permission behavior is covered with isolated fixtures; database write integration uses a disposable test database only.

## Caches that can affect displayed numbers

| Cache | Current behavior |
| --- | --- |
| Frontend React Query | Account-scoped query keys, shared provider queries, centralized polling, cleared on login/logout account transition |
| Frontend aggregation | WeakMap memoization by stable sheet row identity/range/roster version |
| QUO stats | Admin-only serialized response cache, 15 seconds, maximum 50 entries; scoped users bypass it |
| QUO live | 45-second durable snapshot and lease plus local participant accelerator |
| QUO webhook directories | Five-minute line and user maps |
| PBX | Login cookie; local call/ring/span accelerators; durable snapshot; two-minute history and 30-second fast-path freshness thresholds |
| ReadyMode | Login cookie; 60-second source cache; five-minute stale fallback; maximum 50; coalesced refresh |
| Sheets | OAuth token, gid/title map, 60-second parsed snapshot, five-minute stale fallback, coalesced refresh |
| Blocked numbers | Five-minute DB read cache invalidated on writes |
| Onboarding/live-transfer/QA | Durable state, AI reservations, and job leases rather than authoritative process-only state |

## Exports

Server XLSX endpoints are `/ob-report/download`, `/ob-analytics/download`, `/live-transfers/download`, and `/qa/download`. Client CSV exports cover team By Files/rows, Backend Statistics, and violation detail tables. No export discards a business value in Phase 1; only filenames and workbook generation timestamps are dynamic.

## Discovered inconsistencies, preserved

1. PBX is described as an HTML scraper in the mission, but the current production adapter establishes a cookie-backed web session and consumes authenticated JSON. The sanitized HTML fixture is evidence only; no HTML ingestion was introduced.
2. ReadyMode retains a separate HTML parser/probe although the current statistics pipeline is CSV-based.
3. Google Sheet 2 has several naming aliases across the brief, configuration, UI, and row metadata. The current code behavior—not the label—is locked: all valid routed rows become `Retained`.
4. IDP-Handled is displayed separately yet contributes to retention rate, while pure retained tiles exclude it.

These findings are characterization results only. No production business calculation was corrected or reinterpreted.
