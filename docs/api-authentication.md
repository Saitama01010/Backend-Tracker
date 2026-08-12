# Default-private API authentication baseline

Branch: `hardening/01-api-authentication`

Base: tested `hardening/00-baseline-regression` commit `b442bdb0b83bc4f5a0ad9c222e40e2eff2013a11`

## Security boundary

Before this phase, private dashboard endpoints such as `GET /api/quo/lines` and `GET /api/violations/verified` returned HTTP 200 without authentication. The invariant is now: every route under `/api` requires an active portal-user bearer token unless its exact method and path appear in the reviewed public integration allowlist.

The guard runs before every API router. It uses the existing JWT secret and database-backed user lookup, so deleted or deactivated users are rejected even when an older token still verifies. Existing route-level role and permission checks remain in place. A request already authenticated by the default-private guard reuses the loaded user at route level rather than querying the user twice.

Successful handler response bodies and status codes are unchanged. Authentication failures are returned explicitly as 401 responses; handlers do not replace them with empty arrays, zero KPIs, or mock data.

## Intentionally public routes

These are the only declared API routes that bypass browser authentication:

| Method and path | Classification | Independent authentication or reason |
| --- | --- | --- |
| `GET /healthz` | Public health/login route | Deployment health probe. Express also serves the corresponding public `HEAD` request. |
| `POST /auth/login` | Public health/login route | Exchanges valid credentials for the existing bearer token. |
| `POST /quo/webhook` | Verified webhook | Requires a valid OpenPhone signature derived from `QUO_WEBHOOK_SECRET`; missing verification configuration returns 503. |
| `POST /openphone/webhook` | Verified webhook | Compatibility alias with the same OpenPhone signature verification. |
| `GET /qa/biweekly-run` | Cron/server-to-server route | Requires `Authorization: Bearer <CRON_SECRET>` inside the handler. |
| `POST /ob-report/import` | Cron/server-to-server route | Requires the `x-import-secret` value matching `OB_IMPORT_SECRET` inside the handler. |

Method, case, suffix, and prefix variants are not public. Unknown future API routes are private by default.

## Browser-authenticated private routes

All routes below require a valid active user. Existing narrower role or permission checks noted here still apply.

| Area | Routes and existing narrower controls |
| --- | --- |
| Identity | `GET /auth/me` |
| Quo/OpenPhone | `GET /quo/lines`; `GET /quo/all-lines`; `GET /quo/line-stats`; `GET /quo/stats`; `POST /quo/sync`; `GET /quo/sync-state`; `GET /quo/live`; `GET /quo/calls` |
| PBX/VoS | `POST /vos/refresh`; `GET /vos/stats`; `GET /vos/missed-no-callback`; `GET /vos/missed-hourly`; `GET /vos/missed-daily`; `GET /vos/missed-breakdown`; `GET /vos/callback-review`; `GET /vos/live` |
| Attendance | `GET /attendance`; `POST /attendance/members`; `PATCH /attendance/members/:id`; `PUT /attendance/record`; `POST /attendance/import`; `GET /attendance/call-logs`; `POST /attendance/set`; `POST /attendance/auto-mark`; `GET /attendance/agent-contacts`. Existing `manage_members` and `edit_attendance` permission gates remain. |
| Google Sheets | `GET /sheet`; legacy `GET /csv-proxy` |
| ReadyMode | `GET /readymode/stats`; `POST /readymode/upload`; `POST /readymode/session/reset`; `GET /nsf/readymode-queue`; `POST /nsf/readymode-queue`; `POST /nsf/readymode-queue/:id/done`; `POST /nsf/readymode-queue/done-by-number`. Upload and session reset retain their existing admin/edit role restriction. |
| Onboarding | `POST /ob-report/refresh`; `GET /ob-report/status`; `GET /ob-report/download`; `GET /ob-analytics`; `GET /ob-analytics/download` |
| Violations | `GET /violations`; `POST /violations/verify`; `DELETE /violations/verify`; `GET /violations/verified` |
| QA reads/workflows | `GET /qa/stats`; `GET /qa/download`; `GET /qa/reviews`; `GET /qa/reviews/:id`; `GET /qa/tasks`; `GET /qa/agents` |
| Live transfers | `GET /live-transfers/status`; `POST /live-transfers/refresh`; `GET /live-transfers/download` |
| Agent roster | `GET /team-agents` |
| Blocked numbers | `GET /blocked-numbers`; `POST /blocked-numbers`; `DELETE /blocked-numbers/:number`. Writes retain their existing admin/edit role restriction. |
| Breaks | `GET /breaks`; `POST /breaks/start`; `POST /breaks/end`; `POST /breaks/log`; `DELETE /breaks/:id`. Writes retain their existing admin/edit role restriction. |

## Admin-only routes

These routes require an active bearer token and then the existing admin role check:

| Area | Routes |
| --- | --- |
| Portal users | `GET /users`; `POST /users`; `PATCH /users/:id`; `DELETE /users/:id` |
| Agent roster administration | `POST /team-agents`; `PATCH /team-agents/:id`; `DELETE /team-agents/:id` |
| Credentialed diagnostics | `GET /vos/debug/calls`; `GET /vos/debug/proxy`; `GET /readymode/probe` |
| QA administration | `POST /qa/evaluate`; `POST /qa/biweekly-run`; `POST /qa/process`; `GET /qa/runs/latest`; `POST /qa/assign-weekly`; `POST /qa/tasks/:id/resolve` |
| Samia | `GET /samia/history`; `GET /samia/users`; `GET /samia/history/:userId`; `GET /samia/number-lookup`; `GET /samia/call-analysis`; `GET /samia/diagnostics`; `POST /samia/chat` |

This inventory covers all 91 declared method/path pairs under `/api`: 85 private and 6 intentionally public. `HEAD /healthz` is additionally recognized because Express supplies it from the GET health route.

## Frontend caller migration

All 76 dashboard HTTP call sites in the following files now use the shared `apiFetch` client:

- `artifacts/agent-dashboard/src/App.tsx`
- `artifacts/agent-dashboard/src/OnboardingPanel.tsx`
- `artifacts/agent-dashboard/src/PhoneTab.tsx`

The shared implementation is `artifacts/agent-dashboard/src/lib/api.ts`. It:

- attaches the stored bearer token only to same-origin requests;
- preserves `HeadersInit`, request bodies, cache settings, and all HTTP methods;
- returns normal `Response` objects for existing JSON and file workflows;
- provides typed JSON and Blob helpers;
- clears the stored session and emits one application logout event on private 401 responses;
- leaves login 401 responses available to the login form without sending a stale token;
- rejects third-party URLs before calling `fetch`, and never logs a token.

Google Sheets browser sources already resolve to `/api/sheet` or the allowlisted `/api/csv-proxy`; the provider URLs are not fetched with the portal token. Server-side provider requests continue using only their provider-specific credentials.

## Tests and verification

Deterministic security tests cover:

- missing and invalid bearer tokens;
- valid active users and refreshed database authorization payloads;
- deactivated or missing users;
- reuse of the globally authenticated user by route-level checks;
- exact public-route matching and default-private future routes;
- token attachment for GET, POST, PUT, PATCH, and DELETE;
- preservation of caller headers, JSON parsing, and XLSX Blob bytes;
- consistent 401 handling;
- refusal to send the token to a third-party origin.

Runtime verification covered all 85 private route/method combinations without a token; all returned 401 before their handlers could read or mutate data. Health returned 200, an empty login request reached the public handler and returned its existing 400, invalid webhook signatures returned 401, the cron route reached its missing-secret 503, and the import route reached its missing-header 403. Sanitized correctly signed webhook fixtures returned 200 from both webhook aliases without invoking a data-changing event type.

The authenticated read-only smoke suite passed 12 checks with one Google Sheets check skipped. It verified application HTML, login/identity, Quo, PBX, Attendance, Onboarding, ReadyMode, Violations, QA/Samia diagnostics, two XLSX downloads, users, and roster data. Browser verification confirmed login restoration, populated dashboard tables/KPIs, date filters, Quo Lines, PBX, ReadyMode, Attendance, Violations, Onboarding, Admin Users, and the Samia entry panel.

Google Sheets remains untestable in this local environment because its service-account email/private-key settings are absent. The existing 502 configuration error is not hidden or converted to empty data.

## Before-and-after KPI comparison

The same closed historical range was requested from the baseline server without authentication and the hardened server with a valid token. Only aggregate sanitized projections and response-key sets were compared.

| Projection | Baseline | Authenticated | Result |
| --- | ---: | ---: | --- |
| Quo total rows | 2,108 | 2,108 | Equal |
| Quo total calls | 2,094 | 2,094 | Equal |
| Quo connected calls | 483 | 483 | Equal |
| Quo missed calls | 119 | 119 | Equal |
| Quo team totals (retention / NSF / CS / other) | 368 / 790 / 259 / 677 | 368 / 790 / 259 / 677 | Equal |
| Attendance members / records | 30 / 29 | 30 / 29 | Equal |
| Attendance off / in / late | 6 / 19 / 4 | 6 / 19 / 4 | Equal |
| Violations late / availability / missed / verified | 4 / 17 / 98 / 9 | 4 / 17 / 98 / 9 | Equal |
| Onboarding report calls / classified | 115 / 0 | 115 / 0 | Equal |
| Onboarding analytics total / inbound / outbound / answered / missed | 108 / 89 / 19 / 85 / 2 | 108 / 89 / 19 / 85 / 2 | Equal |

Top-level and KPI response-key sets were also identical for every compared endpoint.

## Commands used

```text
pnpm install --frozen-lockfile
pnpm run test:security
pnpm run test:baseline
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server exec tsx --env-file=<existing-private-env> --test src/baseline/smoke.test.ts
```

No branch was pushed, merged, or deployed. No sync, refresh, import, upload, edit, create, delete, verification, QA generation, or Samia model request was invoked during authenticated regression verification.
