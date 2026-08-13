# Backend architecture cleanup report

Report date: 2026-08-13. This branch is a behavior-preserving structural
refactor. It is not merged and has not been deployed to Production.

## Starting state

- Starting `origin/main`: `d7e5246e8d001afb7b9b7593f074876f9c187ded`.
- Starting Vercel Production: Ready deployment
  `dpl_6u2egkKDUQ9KkNPZhMxRYNFjSt2a` at the same Git SHA.
- Branch: `refactor/backend-architecture-cleanup`, created in an isolated
  worktree. The original checkout remained untouched on
  `perf/dashboard-runtime-optimization`.
- Scope: `artifacts/api-server/src` and `lib/db/src`.
- Baseline size: 111 production TypeScript files, 23,135 production lines,
  25 route files, 14,252 route lines, and 98 endpoint declarations.
- Coupling baseline: 19 route files imported database/query primitives, route
  files contained 24 direct `fetch` sites and 33 direct environment reads, and
  the production API/DB scope contained 74 direct environment reads.
- Major debt: HTTP/provider/SQL/report responsibilities were combined in large
  route files; job handlers depended upward on routes; Quo transcript/retry
  clients were duplicated; standalone startup and database seeding were mixed
  in `index.ts`; and both `middleware/` and an empty `middlewares/` existed.

The detailed pre-change inventory, all 98 endpoints, integrations, data
ownership, cross-cutting concerns, debt classification, and target dependency
direction are recorded in `docs/backend-architecture-baseline.md`.

## Architecture before

The normal request path was:

```text
Express app
  -> default-private authentication
  -> route authorization policy
  -> feature route
       -> HTTP parsing and validation
       -> SQL/Drizzle and provider fetches
       -> business calculations and caching
       -> serialization and error selection
```

- `app.ts` constructed the singleton Express app and registered platform
  middleware and routes. `routes/index.ts` applied authentication,
  authorization, rate limits, and 24 feature routers.
- Business logic was split between useful `lib/` helpers and route modules.
  Onboarding analytics/reporting and live transfers kept nearly their entire
  application operation inside HTTP route owners.
- Specialized SQL and Drizzle were appropriate, but 19 route modules reached
  directly into data/query primitives.
- Quo/OpenPhone, VoS/PBX, ReadyMode, Google Sheets, and Anthropic access was
  mostly route-owned. The onboarding and live-transfer transcript clients had
  the same timeout/retry/parsing contract in two copies.
- Eight real middleware files lived in `src/middleware/`; the plural directory
  contained only `.gitkeep` and had no import, script, job, or runtime caller.
- Operational mappings and timezones were centrally validated, while provider
  credentials and feature/startup values were still interpreted ad hoc.
- The platform final error handler sanitized unhandled errors, but route-level
  error bodies/log fields remained operation-specific for compatibility.
- Pino/Pino HTTP was already the runtime logging owner. Production source had
  no ad hoc console logging outside benchmark/build tooling.

## Problems found

| Class | Issue and affected paths | Risk and cause | Action |
| --- | --- | --- | --- |
| Duplication | Transcript fetch/retry/parsing in `routes/obReport.ts` and `routes/liveTransfers.ts` | Retry timing, headers, defaults, and errors could drift because later patches copied a provider operation | Added an old-vs-new characterization oracle and consolidated the exact contract in `integrations/quo/transcripts.ts` |
| Dead code | `src/middlewares/.gitkeep`; two unused `rangeFromQuery` helpers | Conflicting folder signal and abandoned local helpers obscured ownership | Removed after import, registration, job, script, test, and build checks |
| Coupling / unclear ownership | `routes/quoSync.ts`; `lib/backgroundJobHandlers.ts` imported callable operations from route modules | Dependency direction ran from jobs into HTTP ownership | Moved unchanged sync behavior to `integrations/quo/sync.ts`; jobs now call onboarding/transfer application modules |
| Oversized responsibility | `index.ts` mixed port validation, listener policy, seeding, account fixups, and attendance fixtures | Startup behavior was difficult to import or test independently | Split port parsing, standalone lifecycle, and startup database tasks into `app/` modules; `index.ts` is three lines |
| Oversized responsibility / coupling | `routes/obAnalytics.ts` mixed HTTP, queries, calculations, and XLSX generation | Pure/application behavior required Express and database-aware route tests | Route now owns auth/input/response; `modules/onboarding/analytics.ts` owns the existing operation and workbook |
| Oversized responsibility / coupling | `routes/obReport.ts` mixed HTTP, Quo sync/transcripts, Anthropic, persistence, state, and XLSX | Jobs and reusable operations depended on an HTTP module | Route now delegates refresh/status/download/import to `modules/onboarding/report.ts` |
| Oversized responsibility / coupling | `routes/liveTransfers.ts` mixed HTTP, Quo/Anthropic, persistence, matching, state, and XLSX | Same as onboarding report, plus duplicated transcript client | Route now delegates to `modules/transfers/liveTransfers.ts`; pure summary logic has direct characterization coverage |
| Dead dependency | `@replit/connectors-sdk`; deprecated empty `@types/bcryptjs` stub | Larger supply-chain/install surface with no import/build/runtime owner | Removed both and regenerated the lockfile; retained `thread-stream` because the Pino build plugin declares it as a peer |
| Testability | Provider clients read globals and constructed fetch behavior internally | Narrow failure/retry behavior required broad mocks | Shared transcript client accepts injected key, fetch, sleep, attempts, and timeout for characterization without changing defaults |
| Inconsistency | 74 production environment reads and mixed validation/error approaches | Historical feature-by-feature development; broad consolidation could change optional-provider/error contracts | Reduced proven reads only; broader configuration/error/validation standardization is deferred |
| Uncertain compatibility | `csvProxy.ts`, legacy KPI handlers, date/status compatibility branches | Static non-use is not proof for registered APIs, performance oracles, or historical semantics | Retained and documented; no speculative deletion |

CodeQL initially flagged a regex in the new architecture test as a high-severity
unanchored URL check. It searched source text and was not runtime validation, but
the ambiguous regex was still replaced with an exact substring assertion. The
alert was not dismissed.

## Architecture after

```text
src/index.ts
  -> app/startStandaloneServer.ts
       -> app/standaloneConfig.ts
       -> app/startupDatabase.ts
       -> app.ts

HTTP route
  -> application module
       -> specialized SQL/Drizzle and/or provider integration
            -> PostgreSQL or external provider

routes/obAnalytics.ts
  -> modules/onboarding/analytics.ts

routes/obReport.ts + durable job handler
  -> modules/onboarding/report.ts
       -> integrations/quo/sync.ts
       -> integrations/quo/transcripts.ts

routes/liveTransfers.ts + durable job handler
  -> modules/transfers/liveTransfers.ts
       -> modules/transfers/liveTransferSummary.ts
       -> integrations/quo/transcripts.ts
```

Authentication, authorization, platform middleware, structured logging,
business-time helpers, durable jobs, AI reservations, and database schemas keep
their existing owners. No dependency-injection framework, generic repository
base class, new validation framework, or global error-contract migration was
introduced.

Seven architecture regression checks now enforce:

1. the standalone port/startup contract;
2. one canonical middleware directory and separated startup owners;
3. Quo sync/transcript ownership outside routes;
4. no Express/DB/XLSX coupling in the onboarding analytics route boundary;
5. no Express/DB/Anthropic coupling in the onboarding report route boundary;
6. no Express/DB/provider coupling in the live-transfer route boundary; and
7. an acyclic relative-import graph for production API TypeScript.

## Removed complexity

| Measure | Before | After | Change |
| --- | ---: | ---: | ---: |
| Production TypeScript files | 111 | 119 | +8 explicit owners |
| Production lines | 23,135 | 23,209 | +74 for boundaries/guardrails |
| Route files | 25 | 24 | -1 (Quo sync moved to integration ownership) |
| Endpoint declarations | 98 | 98 | unchanged |
| Route lines | 14,252 | 11,172 | -3,080 (-21.6%) |
| Route files importing DB/query primitives | 19 | 15 | -4 |
| Route `fetch` sites | 24 | 20 | -4 |
| Route environment reads | 33 | 26 | -7 |
| Production environment reads | 74 | 67 | -7 |
| Quo transcript client implementations | 2 | 1 | -1 duplicate |
| Proven dead helpers/placeholders | 3 | 0 | -3 |
| Direct dependencies | baseline | baseline -2 | 2 removed |
| Production import cycles | 0 | 0 | none introduced; CI guard added |

No endpoint, route prefix, successful response field, database object, index,
migration, frontend module, provider retry default, prompt, model, KPI formula,
team mapping, or timezone rule was removed or changed.

## Largest files before and after

The largest remaining files show that this was not line-count theater. Complex
but unchanged domains stay explicit and are listed as debt.

| Before | Lines | After | Lines |
| --- | ---: | --- | ---: |
| `routes/vos.ts` | 2,015 | `routes/vos.ts` | 2,015 |
| `routes/samia.ts` | 1,907 | `routes/samia.ts` | 1,907 |
| `routes/quo.ts` | 1,486 | `routes/quo.ts` | 1,486 |
| `routes/qa.ts` | 1,162 | `routes/qa.ts` | 1,162 |
| `routes/obAnalytics.ts` | 948 | `modules/onboarding/analytics.ts` | 899 |
| `routes/attendance.ts` | 841 | `routes/attendance.ts` | 841 |
| `routes/obReport.ts` | 841 | `routes/readymode.ts` | 823 |
| `routes/liveTransfers.ts` | 829 | `modules/transfers/liveTransfers.ts` | 717 |
| `routes/readymode.ts` | 823 | `modules/onboarding/report.ts` | 711 |
| `routes/quoSync.ts` | 691 | `integrations/quo/sync.ts` | 691 |

Focused decompositions were `index.ts` 324 -> 3 lines,
`routes/obAnalytics.ts` 948 -> 51, `routes/obReport.ts` 841 -> 113, and
`routes/liveTransfers.ts` 829 -> 65. Their application logic remains visible in
named modules rather than being hidden behind generic wrappers.

## Tests and quality gates

- Locked install: pass.
- ESLint and TypeScript: pass.
- Diff/format policy (`git diff --check`): pass.
- Default API tests: 97/97 pass.
- Baseline regression: 5/5 pass.
- Frontend API/security compatibility: 13/13 pass.
- API security regression: 99 pass, 7 environment-gated; login/session, AI
  reservation/cleanup, durable jobs, and webhook integrations all passed in
  separate PostgreSQL runs.
- Characterization added: two Quo transcript oracle/retry tests and one live
  transfer classification/summary test.
- Architecture regression: 7/7 pass.
- Frontend performance: 11/11 pass.
- Backend database performance: 4/4 pass with 220,000 sanitized call rows and
  result digests equal across legacy/optimized algorithms.
- Data correctness: 16/16 pass, including PostgreSQL attendance coverage.
- Disposable database bootstrap, intentional non-empty refusal, 44-object
  schema contract, and 4/4 release-readiness tests: pass.
- Production API and dashboard builds: pass. Bundle budget passes at 896,799
  raw / 261,492 gzip bytes (unchanged known chunk/sourcemap warnings remain).
- Dependency audit: no high/critical advisories.
- GitHub dependency audit, OSV, and Gitleaks secret scan: pass.
- Repository CodeQL workflow: pass on the original PR revision; the additional
  PR alert was corrected and must be green on the final report revision.
- Vercel Preview build and unauthenticated `/api/healthz`: pass (HTTP 200).
- Guarded live smoke remained skipped because no live-smoke authorization was
  supplied; the guard was not bypassed.

## Behavior-equivalence evidence

- KPI outputs, team/agent totals, call status/duration fields, attendance,
  onboarding, and violations remain covered by sanitized baseline fixtures and
  database performance digests.
- Team, agent, date, tab, and today-only authorization remain covered by the
  existing central-policy and route-level security suites. All 85 private
  route/method pairs still have explicit policy coverage.
- Quo transcript success/default/404/401/429/503 results were compared against
  a copied pre-refactor oracle. Retry delay, headers, attempt count, and terminal
  success are characterized.
- Live-transfer partner/legacy/unspecified/internal-department totals are
  characterized directly.
- Background-job idempotency/retry/state behavior and webhook persistence are
  database-tested after their imports moved away from routes.
- Existing successful API response construction remains pinned by the baseline
  suite, frontend parsers, security/API tests, and XLSX response tests.
- No frontend source changed. Sheets, ReadyMode, and VoS/PBX route bodies are
  byte-for-byte unchanged from `origin/main`.

## Performance

Matched before/after measurements ran the same source harness with five
warm-ups and 30 samples per endpoint, an existing active authorization session,
and PostgreSQL server-enforced read-only mode. No Production row could be
written. Payload sizes were equal and all requests returned HTTP 200.

| Endpoint | `origin/main` p50 / p95 | Branch p50 / p95 | p50 / p95 change |
| --- | ---: | ---: | ---: |
| `/api/quo/stats` fixed July | 312.66 / 329.51 ms | 312.27 / 327.13 ms | -0.1% / -0.7% |
| `/api/quo/live` | 453.47 / 626.56 ms | 447.53 / 465.87 ms | -1.3% / -25.6% |
| `/api/readymode/stats` fixed July | 305.18 / 319.44 ms | 295.71 / 312.81 ms | -3.1% / -2.1% |

The separate 20-client sanitized load gate also passed: the final branch sample
was 267.65/367.32 ms for stats and 372.87/408.76 ms for Quo live, with zero
errors and all 60 repeated stats reads hitting the scoped cache.

Current deployed Production application-log baselines remain 36/656 ms for
`/api/quo/stats`, 14/61 ms for `/api/quo/live`, 465/926 ms for `/api/sheet`, and
384/1,959 ms for `/api/readymode/stats`. The cleanup does not remove the current
database index, scoped caches, durable live state, or five-second on-call client
architecture.

Two required after measurements are not available:

- Google Sheets: the local environment has no service-account credentials and
  the PR Preview has no general preview `DATABASE_URL`. The Sheets route is
  unchanged and its contract/security tests pass, but no branch p50/p95 was
  fabricated.
- PBX/on-call: the locally stored VoS credentials currently receive provider
  HTTP 401. The VoS route is unchanged, but branch p50/p95 cannot be claimed.

## Remaining architecture debt

- `vos.ts`, `samia.ts`, `quo.ts`, `qa.ts`, `attendance.ts`, and `readymode.ts`
  still combine multiple responsibilities. They were deliberately left intact
  because this branch did not add sufficient characterization to move their
  provider/business/query boundaries safely.
- Onboarding and transfer application modules now have clear HTTP ownership but
  still combine specialized persistence, calculation, provider, and workbook
  concerns. Further repository extraction should follow observed reuse or
  testing need, not a generic layer mandate.
- Provider configuration and error contracts remain operation-specific. A
  broad environment/error/validation rewrite would be a separate compatibility
  project.
- There is no explicit signal-driven graceful DB/server shutdown path for the
  standalone process.
- `csvProxy.ts` and legacy performance handlers remain registered or tested
  compatibility paths; removal requires caller/runtime evidence.
- The known large frontend entry chunk and UI source remain for the separate UI
  v2 project.

## Recommendation

The structural refactor is behaviorally strong, schema-free, reviewable, and
green on local/CI correctness gates. The PR must remain draft and unmerged until
the final CodeQL rerun is green and authenticated branch p50/p95 evidence is
captured for Google Sheets and PBX/on-call with valid non-Production test
configuration or another authorized read-only method.

ARCHITECTURE CLEANUP NOT READY
