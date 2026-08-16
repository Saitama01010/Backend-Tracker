# Phase 1 behavior-lock report

## Outcome

Phase 1 adds a characterization safety net around the application at baseline SHA `542201004c51a5af8c457e0015a71b733c9a2e04`. Production business calculations, provider integrations, database records, authorization decisions, and response behavior were not redesigned or corrected. The only production-source edits export existing pure helpers so fixtures can characterize them directly.

The executable inventory traces all 19 dashboard/login/admin surfaces, 99 declared Express endpoints (plus the implied `HEAD /healthz` behavior), route tables, external sources, exports, roles, date restrictions, jobs, imports, and caches. Its coverage test fails when a declared production route or page mapping disappears.

## Added protection

- Sanitized fixtures cover paginated QUO JSON; PBX JSON plus HTML evidence; ReadyMode CSV and retained HTML parsing; Google Sheet 1 IDP Handled, Retained, and Fixed tabs; and Google Sheet 2 IDP Handled Retained rows.
- Golden values pin the major dashboard response families, including explicit empty ranges, summary values, agent/day/detail values, sync/refresh state, and the current wrapper shapes for QUO lines and blocked numbers.
- Invariants pin Sheet 2 as pure `Retained`, keep IDP Handled/Retained/Fixed separate, retain duplicate-looking rows, preserve current provider mappings, and keep onboarding analytics XLSX values equivalent to its API input.
- Existing authorization and date-scope tests are part of the dedicated command, covering admin, legacy scoped roles, canonical Agent/Manager access, agent/team/subtab restrictions, today locking, DST boundaries, unauthenticated access, and fail-closed behavior.
- The browser test logs in through the real React UI with intercepted sanitized APIs, visits every inventoried dashboard surface, applies date presets, switches By Call/By Files/By Day, refreshes where available, exercises CSV/XLSX exports, and rejects blank/zero-only panels, unmocked API failures, page errors, console errors, and Vite overlays.
- The fixed performance harness records raw API, database, dashboard, payload, memory, request-count, and parser metrics. A CPU-normalized QUO mapping gate fails beyond 10% of the recorded baseline.
- CI boots and migrates PostgreSQL before installing Chromium and running `pnpm test:business-contracts`.

## Current behavior deliberately preserved

- Sheet 2 is called `idpCancelRetained` in code and forces every valid routed row to `Retained`, even when note text says “cancelled.”
- `IDP-Handled` is a separate display category and contributes to the retention-rate numerator, but pure retained count tiles exclude it.
- Duplicate-looking Sheet and ReadyMode rows are not given a new Phase 1 deduplication rule.
- PBX display aliases and roster fallback matching remain directional and context-dependent.
- Provider and sheet date logic continues to use the existing Los Angeles/Cairo boundaries.

## Discovered inconsistencies, not fixed

1. The mission describes PBX HTML scraping, while `vos.ts` currently authenticates to and consumes JSON endpoints. HTML fixtures are evidence only; no new HTML production path was introduced.
2. ReadyMode still contains a best-effort HTML parser/probe, while current statistics are assembled from CSV inputs.
3. Google Sheet 2 uses different names in the brief and source, although its forced-`Retained` behavior is unambiguous.
4. IDP Handled is separate in displayed counts but included in retention-rate semantics.

## Remaining unprotected behavior

- The suite does not contact live QUO, PBX, Google, ReadyMode, or Anthropic services; provider authentication, upstream schema drift, and live rate-limit behavior require isolated staging/provider contract checks.
- Destructive admin mutations, real cron execution, webhook delivery, AI-generated Samia content, and provider refresh writes are protected by existing unit/integration tests and authorization contracts, but the new browser smoke intentionally does not submit them.
- Golden coverage is representative by response family rather than one snapshot for every possible query permutation of all 99 routes. The behavior map makes those remaining route-level boundaries explicit.
- Browser automation uses a sanitized local admin identity and intercepted APIs, not a real staging account, to keep the suite deterministic and secret-free.

## Verification protocol

The disposable PostgreSQL 16 database is `backend_tracker_phase1_test` on localhost only. The browser suite uses Vite on port 4175 with no Production traffic. Completion requires the dedicated safety command to pass three consecutive times, followed by the existing lint, typecheck, unit, build, and database bootstrap/schema gates.

```powershell
$env:DATABASE_URL='postgresql://phase1:phase1@127.0.0.1:54341/backend_tracker_phase1_test'
$env:BUSINESS_CONTRACT_DATABASE_URL=$env:DATABASE_URL
$env:DATABASE_ENVIRONMENT='test'
pnpm run test:business-contracts
pnpm run test
pnpm run lint
pnpm run typecheck
pnpm run build
```
