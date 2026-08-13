# Backend architecture baseline

Baseline captured on 2026-08-13 before architecture cleanup. This is an
inventory and debt report, not a proposed rewrite.

## Starting state

- Freshly fetched `origin/main`: `d7e5246e8d001afb7b9b7593f074876f9c187ded`.
- Vercel Production: deployment `dpl_6u2egkKDUQ9KkNPZhMxRYNFjSt2a`, Ready at
  the same Git SHA.
- Refactor branch: `refactor/backend-architecture-cleanup`, created from that
  commit in an isolated worktree.
- The original checkout was clean but remained untouched on the divergent
  `perf/dashboard-runtime-optimization` branch.
- Scope counts: 111 production TypeScript files and 23,135 production lines in
  `artifacts/api-server/src` plus `lib/db/src`; 25 route files, 98 endpoint
  declarations, and 14,252 route-layer lines.
- Coupling signals: 19 route files import database/query primitives, 24
  route-level `fetch` call sites, two route files import the Anthropic SDK, and
  74 direct production `process.env` reads across the API and DB sources.

The unmodified baseline passed type checking, ESLint, and the Production build.
The default test command passed 32 tests and aborted two database-importing
suites because this isolated worktree intentionally had no database URL. No
unknown or Production database was used to fill that gap.

## Application bootstrapping

| Concern | Current owner | Baseline behavior |
| --- | --- | --- |
| Vercel entry | `api/[...path].ts` | Imports the prebuilt Express app; does not start a listener. |
| Standalone entry | `artifacts/api-server/src/index.ts` | Validates port/config, starts Express, seeds users and attendance demo data, optionally performs legacy account mutations, then applies HTTP server timeouts. |
| Express construction | `artifacts/api-server/src/app.ts` | Constructs a singleton app at import time. |
| Route registration | `artifacts/api-server/src/routes/index.ts` | Applies default-private authentication, route authorization, action rate limits, and all feature routers. |
| Middleware registration | `artifacts/api-server/src/app.ts` | Request IDs, Helmet, Pino HTTP, CORS, compression, stable errors, global rate limiting, cache headers, body parsers, routes, 404, static UI, and final sanitization. |
| Configuration | `lib/operationalConfig.ts` plus scattered reads | Business mappings/timezones/models are validated centrally; provider credentials, feature limits, startup, session, and platform values are still read ad hoc. |
| Database initialization | `@workspace/db` import | Loads root `.env`, creates one PostgreSQL pool and Drizzle client at module import; migrations are separate commands. |
| Background jobs | `routes/backgroundJobs.ts`, `lib/backgroundJobHandlers.ts`, durable job modules | Vercel cron or authenticated manual requests enqueue/claim PostgreSQL-backed jobs. No process-local scheduler is intended. Job handlers currently import callable operations from route modules. |
| Caching/runtime state | Route modules plus `durableRuntimeState.ts` | A mix of process-local TTL/coalescing caches and PostgreSQL runtime snapshots/leases. Quo live retains the current five-second client-facing architecture. |
| Shutdown/startup | `index.ts`, `httpServerPolicy.ts` | Listener errors exit. Timeouts and connection limits are configured. There is no explicit signal-driven graceful close of the HTTP server or DB pool. |

## HTTP inventory

Every route is authenticated by the default-private middleware in
`routes/index.ts` unless it is explicitly classified in `apiPolicy.ts` as a
health/login, cookie-session, verified-webhook, or server-to-server route.
Authorization is then enforced by `authorizationPolicy.ts`; local route
middleware is additional defense, not the sole boundary.

| Route owner | Endpoints | Authorization | Logic, data, integration, and cache ownership |
| --- | --- | --- | --- |
| `health.ts` | `GET/HEAD /healthz` | Public health probe | HTTP-only static response. |
| `auth.ts` | login, refresh, logout, me | Public/session routes; me is authenticated | Credential validation, user/session DB access, cookies, token serialization, and login logging remain in the route. |
| `users.ts` | list/create/update/delete users | Admin | Validation, password hashing, session revocation, and direct Drizzle access in the route. |
| `teamAgents.ts` | list/create/update/delete team agents | Read for metrics/attendance; mutations admin | Manual validation, team/agent rules, and direct Drizzle access in the route. |
| `blockedNumbers.ts` | list/create/delete blocked numbers | Admin read; admin/edit mutations | Route delegates reads to a cached helper but owns writes and cache invalidation. |
| `breaks.ts` | start/end/log/delete/list breaks | Attendance read; admin/edit mutations | HTTP validation, date rules, authorization checks, and Drizzle queries are mixed. |
| `attendance.ts` | attendance read, member CRUD, record write, import, call logs, set, auto-mark, contacts | Permission and scoped-agent/date policies | CSV parsing/fetch, import planning, attendance rules, SQL/Drizzle, call aggregation, authorization, and response shaping are mixed. It reuses attendance policy/service, business-time, and bulk-plan helpers. |
| `violations.ts` | list, verify, delete verification, verified list | Violations tab; delete admin | Validation, date/attendance rules, authorization, cached agent directory, and direct Drizzle access are mixed. |
| `quo.ts` | lines, line stats, stats, sync, sync state, live, refresh, calls | Admin system routes; scoped metrics/live access | Express handlers own provider client/rate gate, classification maps, DB aggregation, response caches, live-poll leases/state, transformations, and serialization. |
| `quoWebhook.ts` | Quo/OpenPhone webhook aliases | Verified webhook | Signature/inbox helpers exist, but provider directory fetches, process caches, call transformation, DB upsert, and live-state mutation remain route-owned. |
| `quoSync.ts` | Callable job operations; no Express endpoints | Invoked by authorized routes/jobs | OpenPhone client/pagination, mapping rules, transformations, direct DB writes, sync state, and scheduling policy are combined in a file under `routes/`. |
| `vos.ts` | refresh, stats, missed reports, callback review, live, debug | Admin/scoped metrics tables | VoS login/client, Quo line fetch, PBX transformations, large process caches, durable snapshots, DB aggregation, ReadyMode queue merging, and HTTP responses are combined. |
| `readymode.ts` | stats, probe, upload, session reset | Scoped metrics; probe/reset admin; upload admin/edit | Provider login/session client, HTML parsing, Google CSV fetch/parsing, DB merge precedence, caches, validation, and handlers are combined. |
| `nsfReadymode.ts` | queue add/list/complete | NSF-capable view; add admin | Queue business rules and direct Drizzle access in route handlers. |
| `sheets.ts` | dashboard sheet read | Backend stats or visible metrics tab | Google service-account parsing/JWT/OAuth, Sheets HTTP client, source allowlist, TTL/coalescing cache, sheet transformation, scoping, and response handling are combined. |
| `csvProxy.ts` | legacy CSV proxy | Admin | Approved URL validation and direct upstream fetch. No current dashboard caller is expected. |
| `qa.ts` | evaluation, runs, processing, assignment, stats, downloads, reviews, tasks, agents | Admin mutations; scoped QA view; cron independently authenticated | Anthropic operations, prompts, tool validation, Quo artifacts, DB selection/writes, scheduling, business policy, exports, and handlers are combined. |
| `samia.ts` | history/users/lookup/analysis/diagnostics/chat | Admin | Internal HTTP calls back into this API, Anthropic orchestration/tools, direct DB access, Quo calls, Google CSV parsing, attendance actions, rate limits, caching, and presentation text are combined. |
| `obReport.ts` | refresh/status/download/import | Admin refresh; onboarding view; secret importer | Quo transcript client, Anthropic classification, DB state/repository operations, sync orchestration, report shaping, Excel generation, and routes are combined. |
| `obAnalytics.ts` | analytics/download | Onboarding view | Query parameters, phone aggregate loading, onboarding calculations, report serialization, and Excel generation are combined. |
| `liveTransfers.ts` | status/refresh/download | Admin refresh; onboarding view | Quo transcript client, Anthropic classification, DB state/repository operations, business matching, Excel generation, and routes are combined. |
| `backgroundJobs.ts` | cron, list, scheduler health, job detail | Cron secret or admin | HTTP validation and durable job API calls; implementation is already mostly delegated. |
| `apiPolicy.ts` | no endpoint | Cross-cutting | Canonical public-route allowlist. |
| `authorizationPolicy.ts` | no endpoint | Cross-cutting | Canonical route and date-range policy; unmapped authenticated routes fail closed to admin. |
| `routes/index.ts` | router composition | Cross-cutting | Authentication, authorization, action throttling, and router registration. |

## Domain and data ownership

- Dashboard statistics are split between `quo.ts`, `vos.ts`, `readymode.ts`,
  `sheets.ts`, `phoneStatsAggregation.ts`, and the frontend. The API route files
  still own substantial classification and response construction.
- Agents and teams are stored in `team_agents` and portal user scope fields.
  Authorization rules live in `middleware/authorizationCore.ts`,
  `lib/authorizationScope.ts`, and route-specific filters.
- Calls are stored in `phone_calls`; Quo ingestion lives in `quoSync.ts` and
  `quoWebhook.ts`, while KPI aggregation is split between `quo.ts`,
  `phoneStatsAggregation.ts`, and VoS reporting.
- Attendance and violations use policy/service helpers, but route handlers still
  own imports, query composition, auto-mark orchestration, and serialization.
- Onboarding, live transfers, QA, and Samia each mix AI provider calls, business
  decisions, persistence, and HTTP/reporting responsibilities.
- Durable background-job, webhook-inbox, AI-reservation, and runtime-state
  primitives are comparatively well isolated in `lib/`, although job handlers
  depend upward on route modules to reach application operations.

Database access is predominantly explicit Drizzle and specialized SQL, which is
appropriate for the query-heavy reports. Ownership is unclear because 19 route
files import `@workspace/db` or `drizzle-orm` directly. Transactions exist for
attendance import, durable jobs, webhook processing, and AI reservation flows;
other multi-step route mutations rely on individual statements. Pagination is
implemented independently in provider loops and shared authorization helpers.

## Integration inventory

| Provider | Current construction and behavior | Demonstrated duplication/coupling |
| --- | --- | --- |
| Quo/OpenPhone | Direct `fetch` clients in `quo.ts`, `quoSync.ts`, `quoWebhook.ts`, `obReport.ts`, `liveTransfers.ts`, `vos.ts`, `samia.ts`, and `lib/quoCall.ts`. Credentials are read in each owner. Timeouts/retries vary by operation. | Repeated base URL/header construction and nearly identical transcript retry/parsing in onboarding and live transfers. Raw provider shapes reach route/business logic. |
| PBX/VoS | Login cookie and retrying fetch client at the top of `vos.ts`. | Client, mutable session, transformations, caches, SQL, and handlers share one 2,015-line module. |
| ReadyMode | Login/session/probe client inside `readymode.ts`; Google CSV and DB uploads are merged into a stable source order. | Provider client and source merge/business logic share the route module. |
| Google Sheets | JWT bearer creation, OAuth token caching, and Sheets fetch inside `sheets.ts`; separate approved public CSV reads exist for legacy/product-specific paths. | Authentication/client mechanics, caching, parsing, authorization scoping, and route response are coupled. CSV parsers are repeated but not yet proven semantically identical. |
| Anthropic | Shared creation/error helpers exist in `lib/anthropic.ts`; QA, Samia, onboarding, and live transfers own prompts, calls, parsing, limits, and persistence. | SDK imports remain in route modules. This cleanup must not change prompts, models, QA behavior, or tool semantics. |

All provider clients currently use finite timeouts in the important paths, but
retry and error contracts are operation-specific. Consolidation must preserve
those differences rather than impose one global retry policy.

## Cross-cutting concerns

- Authentication and authorization have canonical policy/core modules, plus
  some intentional local defense-in-depth middleware.
- `src/middleware/` contains the eight real middleware files.
  `src/middlewares/` contains only a tracked `.gitkeep`, has no imports, and is
  an obsolete structure placeholder.
- Pino/Pino HTTP is the application logger. Production source has no ad hoc
  `console` calls outside standalone tooling/build paths. Error logging styles
  and fields still vary by route.
- `platformControls.ts` contains a small `PlatformHttpError` model and sanitized
  final handler, but many routes manually select status/error JSON. Successful
  response compatibility currently depends on those route implementations.
- Validation is a mix of policy helpers, Zod in selected AI/schema paths, and
  repeated manual parsing. Existing small helpers are preferable to adding a
  new framework.
- Business timezone logic is centralized in `businessTime.ts` and guarded by
  DST/compatibility tests. Several report routes still contain local range/date
  wrappers with subtly different permissive behavior; those are not safe to
  merge without characterization.
- Request IDs, security headers, CORS, compression, rate limiting, cache-control,
  and body limits are centralized in `app.ts`/`platformControls.ts`.

## Technical-debt classification

### A. Structural duplication

- **Provider clients:** Quo credentials/base URL/fetch behavior are constructed
  in at least eight modules; onboarding and live-transfer transcript clients
  are materially duplicated.
- **Middleware structure:** singular directory is canonical; plural directory
  is an unused placeholder.
- **Date-range wrappers and CSV parsing:** repeated implementations exist, but
  their fallback and timezone semantics differ. They are candidates for tests,
  not immediate deletion.
- **HTTP errors:** repeated `catch`/log/status/error JSON blocks have no common
  typed upstream-error boundary.

### B. Oversized modules

- `vos.ts` (2,015 lines): provider login/client, provider and Quo fetches,
  normalization, callback matching, process/durable caches, DB queries,
  ReadyMode merge, scoping, and ten handlers.
- `samia.ts` (1,907): internal API client, history/lookup/analysis queries,
  Anthropic orchestration, tool/action execution, spreadsheet parsing, and
  seven handlers.
- `quo.ts` (1,486): provider client/rate limiting, mappings, KPI query/shape,
  response cache, live poll/leases/state, and nine handlers.
- `qa.ts` (1,162): prompt/rubrics, Anthropic calls, persistence, schedulers,
  assignment policy, reports, exports, and thirteen handlers.
- `obAnalytics.ts`, `obReport.ts`, `attendance.ts`, `liveTransfers.ts`, and
  `readymode.ts` each combine at least four independently testable
  responsibilities. Size alone is not the finding; mixed ownership is.
- `index.ts` (307): port/config validation, HTTP lifecycle, password handling,
  database seeding, fixed attendance fixtures, and legacy account mutations.

### C. Dead or obsolete code

- `src/middlewares/.gitkeep` is proven unused by imports, route registration,
  builds, scripts, and tests.
- `legacyQuoStatsHandler` and `legacyQuoLiveHandler` are exported alongside
  optimized handlers. They are used by equivalence/performance tests and are
  therefore characterization oracles, not dead code.
- `csvProxy.ts` is described by policy as legacy and has no dashboard caller,
  but it remains a registered, authorized API compatibility path; defer removal.
- Legacy database columns/status values and date branches are compatibility
  contracts and must remain.

### D. Inconsistent patterns

- Central operational configuration coexists with direct route-level env reads.
- Provider failures use route-specific errors/status selection and log fields.
- Route files use direct DB access, shared policy/service helpers, or both.
- Most imports use emitted `.js` suffixes, while a few route imports omit them.
- Some routes repeat local `requireAuth`/role middleware after central policy;
  this is retained as defense in depth unless equivalence is proven.

### E. Coupling

- Background job handlers import business operations from `routes/`, reversing
  the preferred application dependency direction.
- Provider response types and fetch mechanics live beside business aggregation.
- Database rows are transformed directly into frontend response shapes in many
  routes.
- Mutable provider sessions and response caches are module globals constructed
  inside route modules.

### F. Testability problems

- Importing many route/service modules constructs the shared DB pool and reads
  global environment configuration immediately.
- Provider clients use global `fetch` and credentials directly, requiring broad
  mocking rather than a narrow client boundary.
- Many operations read `new Date()` internally; business-date helpers are
  injectable, but route orchestration often is not.
- SQL, provider I/O, transformations, and HTTP responses are interleaved, so
  pure behavior cannot always be characterized without a database and server.

## Target dependency direction

The pragmatic target is:

```text
HTTP route
  -> application/domain operation
    -> specialized repository and/or provider integration
      -> PostgreSQL or external provider
```

Authentication, authorization, configuration, validation, logging, errors,
dates, and runtime-cache primitives remain cross-cutting modules. This cleanup
will add only boundaries that remove demonstrated coupling. It will not add a
dependency-injection framework, generic repository base classes, new database
schema, new business rules, provider rewrites, or a frontend redesign.

Initial low-risk work is limited to: removing the proven empty middleware
placeholder; separating standalone startup/seeding from the entrypoint;
extracting exact duplicated provider mechanics behind narrow integration
modules; moving callable background operations out of `routes/`; decomposing a
representative behavior-heavy route only after characterization; and adding a
few architecture regression rules. Uncertain compatibility paths remain and
are listed as debt rather than deleted.
