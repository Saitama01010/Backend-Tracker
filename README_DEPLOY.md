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
DASHBOARD_PASSWORD=tracker2026
PORT=8080
```

Optional integration variables can stay unset unless you use those features.

## 3. Install dependencies

```bash
pnpm install
```

## 4. Push the Drizzle schema to Neon

The Drizzle schema is exported from `lib/db/src/schema/index.ts`, and the Drizzle config is `lib/db/drizzle.config.ts`.

Run:

```bash
pnpm --filter @workspace/db run push
```

This uses `drizzle-kit push`. Do not use `push-force` unless you intentionally accept the risk of forced schema changes.

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
DASHBOARD_PASSWORD=tracker2026
PORT=8080
```

Add the optional integration variables from `.env.example` only when the matching feature needs them.

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

Background interval jobs are disabled on Vercel by default because serverless functions are not a reliable place for long-running workers. On-demand API routes still work, but long imports, classification jobs, or report generation can hit serverless execution limits. If those jobs become central, run the API or workers on a separate always-on host.
