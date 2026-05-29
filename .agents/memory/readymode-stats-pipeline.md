---
name: ReadyMode stats pipeline
description: How GET /api/readymode/stats merges multiple sources and how the portal CSV upload feeds it.
---

# ReadyMode stats pipeline

`GET /api/readymode/stats` aggregates ReadyMode call stats by merging multiple
sources, deduped by **(normalized agent name, day)**. Normalization is
`trim().toLowerCase().replace(/\s+/g, " ")`.

Source priority (highest wins on conflict):
1. attached-asset CSVs (bundled files)
2. Google Sheet CSV
3. **DB uploads** (`readymode_uploads` table) — range-scoped by `stat_date`

`parseReadymodeRows(text, log, source, fallbackIso?)` is the single shared parser
used by both the stats ingest and the upload route. Required columns: Name, Logged
calls; Day/date and talk time optional. `dayToIso` only parses "May 14"-style
dates and returns null for weekday/separator rows.

**Daily reports carry no calendar date.** The "Day/date" column is a weekday name
("Thursday") or "-", not a date. So the parser falls back to `fallbackIso` (the
date the operator picks at upload time) when a row's day cell isn't a parseable
date. Each agent appears twice (a weekday row + a "-" total row with identical
values); the (agent, day) dedup collapses them. The grand-total **"Summary"**
(and "Total") row carries the sum of all agents' calls (e.g. 999) and is skipped
by name — never store it as an agent.

## Portal upload
`POST /api/readymode/upload` (auth-gated: `requireAuth` + `requireRole("admin","edit")`)
parses the CSV, dedupes by (agent, day) keeping last, and bulk-upserts into
`readymode_uploads` via `onConflictDoUpdate` on the unique `(agent_name, stat_date)`.

**Why the stored agent name is canonicalized (trim + collapse internal
whitespace):** the DB unique key is the *raw* `agent_name` text, but every other
dedup path normalizes. Without canonicalizing the stored value, whitespace/casing
variants across uploads would insert near-duplicate rows and make "last wins"
non-deterministic. ReadyMode exports a consistent name per agent, so canonicalizing
on write is enough to guarantee same-day re-uploads upsert the same row. If a
truly case-insensitive guarantee is ever needed, switch to a functional unique
index on the normalized name.

Dashboard: upload button is gated to admin/edit, reads the file as text, POSTs with
the bearer token, then invalidates the `["readymodeStats", ...]` query.
