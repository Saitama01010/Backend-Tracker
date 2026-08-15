# Deploy Backend-Tracker with GitHub, Vercel, and Neon

This repo is a pnpm monorepo:

- Frontend dashboard: `artifacts/agent-dashboard`
- Express API server: `artifacts/api-server`
- Drizzle/PostgreSQL package: `lib/db`

The Vercel setup builds the Vite dashboard as static files and serves the Express API through `api/[...path].ts`.

## 1. Create a Neon database

1. Create a Neon project.
2. Create or select a PostgreSQL database.
3. Copy the database connection string.
4. Keep the connection string private. Do not commit it.

## 2. Create a local `.env`

Create `.env` in the repo root by using `.env.example` as the key list.

Minimum local values:

```env
DATABASE_URL=<your Neon PostgreSQL connection string>
QUO_API_KEY=
OB_IMPORT_SECRET=
SESSION_SECRET=<generate a long random value>
DASHBOARD_EMAIL=<admin login email>
DASHBOARD_PASSWORD=<set a strong admin password>
PORT=8080
```

Optional integration variables can stay unset unless you use those features.

To enable the admin-only Samia chatbot with Claude, add:

```env
ANTHROPIC_API_KEY=<your Anthropic API key>
ANTHROPIC_SAMIA_MODEL=claude-sonnet-5
ANTHROPIC_QA_MODEL=claude-haiku-4-5
ANTHROPIC_LT_MODEL=claude-haiku-4-5
ANTHROPIC_OB_MODEL=claude-haiku-4-5
SAMIA_REQUESTS_PER_MINUTE=6
SAMIA_REQUESTS_PER_DAY=50
QA_REVIEW_INTERVAL_DAYS=14
QA_MIN_CALL_SECONDS=90
CRON_SECRET=<generate a separate long random value>
```

`ANTHROPIC_API_KEY` is read only by the API server. Never prefix it with `VITE_`
or expose it in frontend code.

## 3. Install dependencies

```bash
pnpm install
```

## 4. Apply reviewed migrations to Neon

The Drizzle schema is exported from `lib/db/src/schema/index.ts`, and the Drizzle config is `lib/db/drizzle.config.ts`.

For an existing database, first run the read-only preflight described in
`docs/database-release-tooling.md`, review its `GO`/`NO_GO` decision, take the
required snapshot, and then run the normal migrator only in the approved
environment:

```bash
pnpm --filter @workspace/db run migrate
```

This applies the checked-in Drizzle migrations. Never use schema push as a
release shortcut. A brand-new disposable or staging database must instead use
the guarded empty-database bootstrap documented in
`docs/database-release-tooling.md`; it refuses Production and non-empty targets.

## 5. Run locally

Start the backend API on port `8080`:

```bash
pnpm --filter @workspace/api-server run dev
```

Start the frontend dashboard on port `3000` in a second terminal:

```bash
pnpm --filter @workspace/agent-dashboard run dev
```

The dashboard uses relative `/api/...` calls. In local development, Vite proxies `/api` to `http://localhost:8080`.

## 6. Push to GitHub

Before pushing, make sure these files are not committed:

- `.env`
- `.replit`
- `PRIVATE_KEYS_BACKUP_DO_NOT_UPLOAD.txt`
- `Backend.env/.env`
- `Backend.env/.replit`

Then push the repo to GitHub.

## 7. Configure Vercel

Create one Vercel project from this repo.

Use these settings:

```text
Framework Preset: Other
Install Command: pnpm install --frozen-lockfile
Build Command: pnpm --filter @workspace/agent-dashboard run build
Output Directory: artifacts/agent-dashboard/dist/public
```

The same values are also stored in `vercel.json`.

Add these Vercel environment variables:

```env
DATABASE_URL=<your Neon PostgreSQL connection string>
QUO_API_KEY=
OB_IMPORT_SECRET=
SESSION_SECRET=<generate a long random value>
DASHBOARD_EMAIL=<admin login email>
DASHBOARD_PASSWORD=<set a strong admin password>
PORT=8080
```

Add the optional integration variables from `.env.example` only when the matching feature needs them.

For every AI feature, add `ANTHROPIC_API_KEY` and `CRON_SECRET` as Vercel secrets,
plus the Anthropic model and limit variables shown above. Samia uses Sonnet;
QA, Live Transfer, and outbound classification use Haiku. The daily Vercel cron
calls the authenticated durable-job endpoint `/api/jobs/cron` at 09:00 UTC.
That recovery cadence does not provide the required one-minute live refresh or
fifteen-minute Quo sync. Select and record an approved high-frequency scheduler
using `docs/scheduler-operations.md` before Production deployment. PostgreSQL
eligibility checks still limit each agent to one automatic review in any
rolling 14-day period.

For private Google Sheet submissions, add one of these setups in Vercel:

```env
GOOGLE_SERVICE_ACCOUNT_JSON=<the full service account JSON as one secret value>
```

Or split the same key into:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=<service account client_email>
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=<service account private_key>
```

Then share every source Google Sheet with the service account email as a viewer. Google Form submissions will appear on the dashboard after the form writes a row to one of those shared sheets.

## 8. Deploy

Deploy from Vercel after the GitHub repo is connected.

Production routing:

- Frontend: static Vite files from `artifacts/agent-dashboard/dist/public`
- API: `/api/*` requests are handled by the Express app through `api/[...path].ts`

Long-running and scheduled work is recorded in PostgreSQL with idempotency keys,
leases, bounded retries, and sanitized outcomes. The checked-in daily Vercel
cron is a recovery path only. Production still requires the explicit scheduler
and isolated-staging decisions in `docs/scheduler-operations.md` and
`docs/staging-environment-handoff.md`.
