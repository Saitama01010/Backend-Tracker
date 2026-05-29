---
name: Google Sheets data path
description: How the agent-dashboard reads submission spreadsheets (authenticated, not public CSV)
---

The dashboard reads all submission spreadsheets through the API server's
authenticated `/api/sheet?id=<spreadsheetId>&gid=<numericGid>` endpoint, which
uses the Replit Google Sheets connector (`google-sheet`) via
`@replit/connectors-sdk`. It returns `{ headers, rows }` (same shape the old
CSV parse produced). The source spreadsheets can therefore be **private** — they
no longer need "Anyone with the link can view".

**Why:** user wanted the submission sheets private while the dashboard kept
working. Public CSV export URLs only work on world-readable sheets.

**How to apply:**
- The dashboard's single `fetchHeaderCsv(url)` parses the spreadsheet id + gid
  out of any Google Sheets URL (still stored as constants) and calls `/api/sheet`.
  Don't reintroduce direct `docs.google.com/.../export?format=csv` fetches.
- The connected Google account must have at least viewer access to every source
  spreadsheet. If a sheet 404s/403s, that account lost access (or the gid changed).
- Server maps gid→sheet title via the spreadsheet metadata endpoint and caches
  it; a cache miss refreshes. Renaming a tab is fine (lookup is by gid).
- `routes/csvProxy.ts` is the legacy public-CSV proxy, now unused by the dashboard.
