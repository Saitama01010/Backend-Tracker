# Server-side API authorization

Branch: `hardening/02-authorization`

Base: tested `hardening/01-api-authentication` commit `64882e36e0226909ccd139f4929d497457ccb8d9`

Captured: 2026-07-15

## Compatibility and security contract

The existing database-backed portal user is still the source of truth. Missing, invalid, deleted, or deactivated identities receive HTTP 401. An active identity that lacks a route, team, agent, tab, subtab, or date entitlement receives HTTP 403. A denied request is never converted into an empty array, a zero KPI, or mock data.

The backend mirrors the dashboard's current `canSeeTab` behavior, including the precedence of explicit `allowedTabs`, team fallbacks, `hideBackendStats`, and the admin role. It also enforces the persisted `permissions`, `teamAccess`, `allowedAgents`, `allowedSubTabs`, and `lockToToday` fields. No new role, permission, team, or tab was introduced.

Coarse route policy runs after default-private authentication and before every API router. Resource-specific checks run inside handlers after the requested member, break, department, roster agent, team, or date has been resolved. Admin and unrestricted response shapes remain unchanged. Restricted successful responses retain the same shapes and contain only their authorized rows with aggregate values recomputed from those rows.

## Persisted authorization evidence

The active user configuration was inspected only as aggregate metadata; no password hash, token, phone number, transcript, or customer record was copied into source or tests.

| Field | Observed configuration evidence |
| --- | --- |
| Role | 2 admin users and 11 view users; no active edit user |
| Permissions | `view_metrics`, `view_attendance`, `edit_attendance`, `manage_members`, and `view_missed_tables` are the persisted permission values in use |
| Team access | Unrestricted, Retention, NSF, and CS configurations are in use |
| Allowed tabs | Explicit Retention, CS, NSF, Missed, Violations, and Onboarding combinations are in use |
| Allowed agents | The field and UI are present, but no active user currently has an agent allowlist |
| Allowed subtabs | Call/files/day configuration is present; three users currently have a restricted selection |
| Today-only | Three active users have `lockToToday` enabled |
| Backend statistics | Eleven active users have `hideBackendStats` enabled |

The deterministic tests use only synthetic identities such as `Agent Alpha` and `Agent Beta`.

## Authorization matrix

Every path below is mounted under `/api`. “Visible tab” means the exact existing frontend rule reproduced server-side. Admin is allowed through permission checks unless a route is explicitly described otherwise.

| Route | Required permission or role | Allowed roles/configurations | Team or agent scoping | Date restriction | Coverage |
| --- | --- | --- | --- | --- | --- |
| `GET /auth/me` | Active authenticated user | admin, edit, view | None | None | auth security tests; live login/identity smoke |
| `GET/POST /users`; `PATCH/DELETE /users/:id` | admin | admin only | None | None | policy matrix; live admin read; browser Admin Users |
| all `/samia/*` private routes | admin | admin only | None | Handler-specific inputs unchanged | policy matrix; diagnostics smoke; browser panel opened without a model call |
| `GET /quo/lines`, `/all-lines`, `/line-stats`, `/sync-state`; `POST /quo/sync` | admin | admin only | None | Existing handler behavior | exhaustive policy matrix; browser Quo Lines read |
| `GET /quo/stats` | `view_metrics` and at least one visible metric-team tab | configured view/edit users and admin | Roster-resolved team plus `allowedAgents`; aggregates recomputed | Today-only users must supply today's range | policy/persona tests; scope fixtures; live API; browser KPI/date tests |
| `GET /quo/calls` | `view_metrics` and visible requested team | configured view/edit users and admin | Requested team is resolved and checked; returned agents are roster/allowlist scoped | Today-only users must request today | policy/persona tests; live manual team/date bypass tests |
| `GET /quo/live` | `view_metrics` or `view_attendance` | configured view/edit users and admin | `teamAccess` and `allowedAgents` | Live only | scope fixtures; browser network verification |
| `POST /vos/refresh` | visible Missed / No CB tab | configured metric users and admin | Existing refresh operation unchanged | Live refresh | policy matrix; not invoked against live data |
| `GET /vos/stats`, `/live` | visible metric team or metrics/attendance respectively | configured view/edit users and admin | Roster-resolved team and `allowedAgents`; dashboard totals recomputed | Current provider data | scope fixtures; live smoke; browser PBX |
| `GET /vos/missed-no-callback` | visible Missed / No CB tab | configured metric users and admin | `teamAccess` is enforced before return | Endpoint's existing today behavior | policy/persona tests; browser Missed view |
| `GET /vos/missed-hourly`, `/missed-daily`, `/missed-breakdown` | `view_missed_tables` and visible Missed / No CB tab | manager-configured users and admin | Existing UI team presentation retained | Existing endpoint ranges | policy/persona tests; browser Missed tables |
| `GET /vos/callback-review` | visible Callback Review tab | configured metric users and admin | No extra scope invented; see ambiguities | Today-only users must request today | policy/date tests |
| `GET /vos/debug/calls`, `/debug/proxy` | admin | admin only | None | None | exhaustive policy matrix |
| `GET /attendance` | `view_attendance` | configured view/edit users and admin | `teamAccess` maps to the existing Retention/NSF/CS department filter | Today-only users must request today | persona tests; live smoke; browser Attendance |
| `GET /attendance/call-logs`, `/agent-contacts` | `view_attendance` | configured view/edit users and admin | Department, roster agent, and `allowedAgents` | Supplied dates are checked for today-only users | policy/date/scope tests |
| `POST/PATCH /attendance/members*`; `POST /attendance/import` | `manage_members` | configured users and admin | Existing and final member departments are resolved before writes; team-limited bulk import is rejected | Imported/member data behavior otherwise unchanged | policy/persona tests; source/handler review; live mutation not invoked |
| `PUT /attendance/record`; `POST /attendance/set`, `/auto-mark` | `edit_attendance` | configured users and admin | Each referenced member is resolved before department authorization | Every supplied record date is checked | policy/date/persona tests; live mutation not invoked |
| `GET /sheet` | visible Backend Stats or visible metric-team tab | configured metric users and admin | Non-backend users require resolvable agent/team columns; `allowedAgents` applied | Today-only users require a resolvable date column and today's rows | sanitized sheet fixtures; browser request; live Sheets skipped for missing credentials |
| `GET /csv-proxy` | admin | admin only | None | None | exhaustive policy matrix; no active dashboard caller |
| `GET /readymode/stats` | `view_metrics` and visible metric-team tab | configured metric users and admin | Roster team and `allowedAgents`; totals recomputed | Today-only users must request today | policy/scope tests; live smoke; browser ReadyMode |
| `GET /readymode/probe` | admin | admin only | None | None | exhaustive policy matrix |
| `POST /readymode/upload`, `/session/reset` | existing admin/edit gate | admin or edit | None | Existing workflow | policy matrix; live mutation not invoked |
| `GET /nsf/readymode-queue`; completion routes | visible Missed / No CB tab and NSF-capable team access | NSF/unrestricted configured users and admin | Retention/CS team locks are rejected | Existing queue behavior | policy/persona tests |
| `POST /nsf/readymode-queue` | admin Samia workflow | admin only | None | Existing workflow | exhaustive policy matrix; live mutation not invoked |
| all `/violations` reads and verification routes | visible Violations tab | explicitly configured metric users and admin | No extra scope invented; see ambiguities | Today-only range is enforced on the report read | policy/date tests; live smoke; browser Violations |
| QA admin operations and latest-run route | admin | admin only | None | Existing workflow | exhaustive policy matrix; live mutations not invoked |
| QA stats/download/reviews/tasks/agents reads | visible QA tab | explicitly configured metric users and admin | No extra scope invented; see ambiguities | Today-only ranges enforced where dates are accepted | policy/date tests; live diagnostics smoke |
| onboarding report/analytics reads, downloads, refresh | visible Onboarding tab | configured metric users and admin | No team/agent scope in current UI | Today-only users must request today on ranged reads/downloads | policy/date tests; live smoke/download; browser Onboarding |
| live-transfer status/download/refresh | visible Onboarding tab | configured metric users and admin | No team/agent scope in current UI | Today-only users must request today on ranged reads/downloads | policy/date tests; live download coverage |
| `GET /team-agents` | `view_metrics` or `view_attendance` | configured users and admin | `teamAccess` and `allowedAgents` filter the roster | None | policy/scope tests; live smoke |
| roster writes | admin | admin only | Final roster identity is controlled by admin | None | exhaustive policy matrix; live mutation not invoked |
| `GET /blocked-numbers` | admin | admin only | None | None | policy matrix; browser admin menu |
| blocked-number writes | existing admin/edit gate | admin or edit | None | None | policy matrix; live mutation not invoked |
| `GET /breaks` | `view_attendance` | configured users and admin | Department, resolved agent, and `allowedAgents` | Today-only ranges enforced | policy/date/persona tests |
| break writes | existing admin/edit gate | admin or edit | Existing break/agent is resolved before end/delete authorization | Break date/time checked for today-only users | policy/date tests; live mutation not invoked |

The six phase-1 public integration entries remain unchanged: health, login, two signature-verified webhook aliases, the secret-protected QA cron, and the secret-protected onboarding import. They do not receive browser authorization middleware. Unknown future private routes default to admin until an explicit policy is added.

## Required persona matrix

| Persona | Expected result | Test evidence |
| --- | --- | --- |
| Admin | All intended dashboards and admin routes; unrestricted response compatibility | unit policy matrix, live API comparison, read-only smoke, browser walkthrough |
| Normal authenticated user | Only routes allowed by persisted permissions and visible tabs | deterministic policy fixtures and live read-only requests |
| Limited team | Other team requests return 403; roster and data rows stay in the permitted team | deterministic scope fixtures, live manual query tests, constrained browser session |
| Limited agent | Alternate spelling/casing cannot bypass the allowlist | deterministic agent and alias fixtures; no active database user currently has this field configured |
| Limited tab | Hidden-tab API returns 403 while the allowed tab remains usable | deterministic policy fixtures and live onboarding-only request checks |
| Today-only | Historical, future, and omitted historical-default ranges return 403 | deterministic timezone/date tests, live manual API checks, constrained browser session with no date picker |
| Deactivated user | 401 even with a cryptographically valid token | authentication security fixture; no live user was deactivated for testing |
| Logged-out user | Private API returns 401 | authentication security fixture and live request |

## Compatibility comparisons

Read-only requests were made to the previous `hardening/01-api-authentication` server and this branch using the same active admin identity and data window. Only aggregate projections and response-key sets were compared.

| Projection | Authentication branch | Authorization branch | Result |
| --- | ---: | ---: | --- |
| Quo source rows | 10,489 | 10,489 | Equal |
| Quo total calls | 10,464 | 10,464 | Equal |
| Quo connected calls | 2,007 | 2,007 | Equal |
| Quo missed calls | 657 | 657 | Equal |
| Attendance members / records | 30 / 150 | 30 / 150 | Equal |
| Attendance in / off / late / PTO / NSNC | 123 / 18 / 6 / 2 / 0 | 123 / 18 / 6 / 2 / 0 | Equal |
| Violations late / gaps / missed / verified | 19 / 106 / 430 / 9 | 19 / 106 / 430 / 9 | Equal |
| Onboarding report total / classified | 711 / 3 | 711 / 3 | Equal |
| Onboarding analytics total / inbound / outbound / answered / missed | 638 / 503 / 135 / 462 / 17 | 638 / 503 / 135 / 462 / 17 | Equal |
| ReadyMode dialed / connected / talk seconds / connect rate | 3,122 / 3,122 / 198,586 / 100 | 3,122 / 3,122 / 198,586 / 100 | Equal |
| Onboarding report workbook | 63,807 bytes | 63,807 bytes | Equal |
| Onboarding analytics workbook | 31,500 bytes | 31,500 bytes | Equal |

Top-level key sets also matched for every compared endpoint. Team and agent projections for the unrestricted admin remained identical.

## Verification results

| Check | Result |
| --- | --- |
| Security suite | 19/19 passed, including all 85 private method/path pairs |
| Deterministic baseline | 5/5 passed |
| Existing API suite with the existing private environment | 57/57 passed |
| Workspace typecheck | Passed |
| Production build | Passed; existing Vite sourcemap-location and large-chunk warnings remain |
| Read-only authenticated smoke | 12 passed, 0 failed, 1 Google Sheets check skipped |
| Browser, admin | Login/session, KPI tables, Today/Yesterday, Retention, CS, NSF, Missed, Violations, Onboarding, Quo Lines, PBX, ReadyMode, Attendance, Admin Users, and Samia entry panel rendered |
| Browser, constrained user | Only Retention and Missed tabs appeared, only Files subtab appeared, date picker and admin controls stayed hidden, authorized rows rendered, and no unexpected 401/403 request occurred |

The browser emitted only the pre-existing Google Sheets 502 configuration errors caused by absent `GOOGLE_SA_CLIENT_EMAIL` and `GOOGLE_SA_PRIVATE_KEY`. The response remains an explicit error and is not masked with empty rows. Download behavior was verified at the HTTP layer with authenticated non-empty XLSX responses.

## Unresolved permission ambiguities

These items were deliberately not guessed:

1. Violations, Callback Review, QA, Onboarding, and Live Transfers do not currently apply a team or agent filter in the frontend. Their routes now require the matching visible tab, but no new dataset narrowing was invented.
2. `allowedSubTabs` controls Call, Files, and Day presentation. Files exports also consume the shared phone-stat APIs, so denying those APIs solely because Call is hidden would break the existing Files workflow. Subtab visibility is reproduced and tested, while shared API payloads remain governed by tab, team, agent, and date scope.
3. No active user currently has `allowedAgents` configured. The backend support is covered with sanitized deterministic aliases, but there is no legitimate live persona available for a browser comparison.
4. Some legacy Quo bucket labels disagree with the current roster team for a small number of roster-authorized agents. Authorization follows the roster identity, while the existing bucket label and KPI placement remain unchanged to avoid silently changing permitted-user numbers.
5. Blocked-number and break writes already allowed the edit role, but there is no active edit-role user and no clearer UI evidence to narrow that established backend behavior. The existing admin/edit gate was retained.
6. The legacy `/csv-proxy` endpoint has no remaining dashboard caller after the phase-1 migration to `/sheet`. It is admin-only rather than being exposed to every authenticated user.

## Commands executed

```text
pnpm.cmd --filter @workspace/api-server run test:security
pnpm.cmd run test:baseline
pnpm.cmd --filter @workspace/api-server exec tsx --env-file=<existing-private-env> --test src/lib/anthropic-features.test.ts src/lib/dashboard-actions.test.ts src/baseline/regression.test.ts
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd --filter @workspace/api-server exec tsx --env-file=<existing-private-env> --test src/baseline/smoke.test.ts
```

Additional read-only comparison scripts were run from temporary, untracked files against local ports for the phase-1 and phase-2 servers, then removed. Browser verification used the local phase-2 server with background jobs disabled. No sync, refresh, import, upload, verification, administrative mutation, QA generation, or Samia model request was invoked.

No branch was pushed, merged, deployed, or applied to `main`.
