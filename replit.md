# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

- **agent-dashboard** (`/`) — Agent Performance Dashboard. React + Vite app with three tabs:
  - **Retention Team** & **NSF Team** — load Google Sheets CSVs via fetch + PapaParse (CSV URLs in `App.tsx`)
  - **Phone** — shows per-agent call stats from OpenPhone/Quo API via the API server + PostgreSQL
- **api-server** (`/api`) — Express 5 API server. Routes:
  - `GET /api/quo/stats?from=&to=` — returns call stats from PostgreSQL DB (instant)
  - `GET /api/quo/lines` — returns classified phone lines from OpenPhone API
  - `POST /api/quo/sync` — triggers background sync from OpenPhone for a date range
  - `GET /api/quo/sync-state` — returns last sync timestamp

## Phone Analytics Architecture

The Phone tab uses a **background sync + DB query** pattern because the OpenPhone API requires `participants[]` per call query, making real-time aggregation infeasible (thousands of unique contacts per line).

**Sync flow** (`artifacts/api-server/src/routes/quoSync.ts`):
1. Fetch conversations updated in the sync window (filtered by `updatedAfter`)
2. Deduplicate unique external participants per phone line
3. Fetch calls per (line, participant) in the date range (8 concurrent workers)
4. Upsert results into `phone_calls` PostgreSQL table

**Background sync**: runs every 15 minutes on server startup, covering the last 2+ hours. First run covers 4 hours.

**Manual sync**: triggered via `POST /api/quo/sync` with `from`/`to` in the request body. Returns immediately; sync runs in background.

**DB schema**: `lib/db/src/schema/phoneCalls.ts` — `phone_calls` and `phone_sync_state` tables.

**OpenPhone API key**: stored in `QUO_API_KEY` env var (format: no Bearer prefix, key directly in `Authorization` header).

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
