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

**Name canonicalization gotcha:** roster `lookupByAnyName` does NOT apply the
module-level `NAME_ALIASES` map — it only matches roster DB names + "-" segments.
Any consumer that aggregates per-agent must ALSO run names through
`normalizeAgent` (which applies `NAME_ALIASES`) on the whole name and each
segment, the way `aggregate()`'s `ensureAgent` / the fetchers do. Skipping this
makes Arabic/compound aliases (e.g. "Ahmed Ayman" vs "Ahmed Ayman-Levi Miller",
"Kevin Michael" vs "Kevin Micheal") split into duplicate rows.
**Why:** alias collapsing lives in `NAME_ALIASES` + `normalizeAgent`, not in the
roster index. **How to apply:** when adding a new per-agent rollup, resolve via
alias-first then roster (see `bstatResolveAgent`), and key the aggregation map on
the canonical key, not the display string.

**IDP-Cancel-Retained:** rows from the "IDP Cancel Retained" sheet tab are stored
as Status "Retained" but tagged `__sourceTab === "IDP-Cancel-Retained"`. To split
them out, read that tag (it survives into the combined SheetData). When deduping,
make the IDP-Cancel tab authoritative on a key collision (upgrade the kept row's
flag) or the split column undercounts.

**Membership caveat:** NSF/CS row→team matching leans on active-only roster name
sets, so `includeInactive:true` does not make matching fully inclusive of every
historical name. Changing that lives in the shared fetchers and would affect all
tabs — don't "fix" it inside one consumer.

**Per-loader default status differs by team (subtle):** the same Discord-bot
(gid=0) row defaults to `Fixed` in the NSF/CS loader (`fetchNewSheetForTeam`,
`kw ?? "Fixed"`) but to `Retained` in the Retention loader
(`fetchRetentionCombinedSheet`). A genuine keyword (retain/cancel), the
IDP-Handled tab, and the IDP-Cancel-Retained tab still override. So an NSF-style
"fixer" agent who is moved onto the Retention team will have their plain fixes
mis-bucketed as `Retained` unless special-cased.
**Why:** Retention agents retain by default; NSF/CS agents fix by default.
**How to apply:** when an agent does fix-work but is org'd under Retention (e.g.
Kayla Navarro / "Jana-Kayla Navarro-2718"), add their aliases to
`RETENTION_FIX_DEFAULT_AGENTS` so the Retention Discord default flips to `Fixed`.

**Team-move requires removing from the OLD team's hardcoded set:**
`rosterTeamMembers()` UNIONs hardcoded sets with roster (it never subtracts), and
`rosterHasAnyForTeam` only bypasses hardcoded when the *whole team* has zero
roster rows. So moving one agent to a new team in the roster does NOT remove them
from the other team's hardcoded set — they double-count on both teams until you
delete their name/aliases from the old set (`NSF_AGENT_NAMES`,
`RETENTION_SHEET_NSF_AGENTS`, `RETENTION_SHEET_CS_AGENTS`, `CS_AGENT_NAMES`).
**How to apply:** team reassignment = roster change + delete from old hardcoded
set + (if they should appear regardless of dev roster) add to the new team's
`*_NORM_EARLY` / name set.
