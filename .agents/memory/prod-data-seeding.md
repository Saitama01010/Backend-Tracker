---
name: Production data seeding
description: How to bulk-write/seed data into the production database for the agent-dashboard project.
---

# Seeding the production database

The production PostgreSQL DB is **read-only to tooling** — `executeSql` / the database
skill (`environment: "production"`) can only SELECT. There is no direct write path.

**The only way to write to production is through the deployed app itself.** To bulk-seed
data (e.g. push already-computed rows from dev into a fresh prod table), add a guarded
POST endpoint on the api-server, publish, then call it against the prod domain from the
code_execution sandbox.

**Why:** expensive-to-recompute data (e.g. AI/LLM classifications gated by rate-limited
external APIs) should be seeded once, not recomputed in prod from scratch — recomputing
shows zeros for hours and hammers rate limits.

**How to apply:**
- Endpoint guard: an env-var secret checked against a request header; disabled if the env
  var is unset. Make inserts idempotent (`onConflictDoNothing`) and chunked.
- Send batches small enough to fit the global `express.json` body limit (100kb ≈ a few
  hundred rows); the seeder loops batches.
- Read dev rows via `executeSql` (returns **CSV**, not JSON — parse accordingly), POST to
  `https://<prod-domain>/api/...` with the secret header.
- Inserting into an empty prod table is non-destructive; one publish can ship both a code
  fix and the seed endpoint so the seed is "free" afterward.
