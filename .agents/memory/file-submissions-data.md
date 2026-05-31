---
name: File submissions data (combined sheets)
description: How "files" data is sourced/shaped, and the overlap/dedupe gotcha when aggregating across teams
---

# File submissions ("files") data

A "file" = one customer-account/case submission by an agent. The three client-side
fetchers `fetchRetentionCombinedSheet` / `fetchNSFCombinedSheet` /
`fetchCSCombinedSheet` are the canonical source the whole dashboard uses. Each
returns `SheetData` with rows shaped `{ Agent, Status, Date, "File ID" }` and
status normalized via `normalizeStatus` into `Retained` / `Fixed` /
`IDP-Handled` / `Cancelled`.

**Overlap/dedupe gotcha (the durable lesson):** these fetchers merge several
loaders that can emit the SAME submission more than once — crossover rows, the
shared IDP-Handled / IDP-Cancel-Retained tabs, and compound-name routing. If you
aggregate rows across teams for a global total, dedupe by a stable key
(`team|date|File ID`) and only when `File ID` is present; rows without a File ID
can't be deduped reliably and dropping them would undercount.
**Why:** without dedupe, a cross-team/all-files rollup inflates totals.
**How to apply:** any new "all files / everyone" rollup (e.g. the Backend
Statistics tab) must dedupe; the per-team panels don't hit this because each only
reads its own team's combined sheet.

**Membership caveat:** NSF/CS row→team matching leans on active-only roster name
sets, so `includeInactive:true` does not make matching fully inclusive of every
historical name. Changing that lives in the shared fetchers and would affect all
tabs — don't "fix" it inside one consumer.
