---
name: Quo stats team bucketing
description: Why /api/quo/stats can silently undercount an agent's calls, and how Samia gets complete per-agent totals
---

# /api/quo/stats team bucketing

`/api/quo/stats` groups OpenPhone calls into team buckets. Historically only
`retention`/`nsf`/`cs` existed, and any call whose team couldn't be resolved
(`agentTeam(name)` had no mapping AND the call's `lineTeam` wasn't one of those
three) was **silently dropped**.

**Why this bites:** agents who work mainly on unclassified lines (e.g. the
"Onboarding" line, stored as `lineTeam = "other"`) had almost all their calls
discarded. Example seen: an agent showed ~23 calls via team stats while the DB
and the dashboard's per-line view showed ~510+. Samia/the assistant faithfully
reported the tiny team-stats number and looked "broken/hallucinating" when she
was actually reporting incomplete data.

**The dashboard never hit this** because its retention/nsf/cs tabs read fixed
team keys, and individual-agent drill-downs use `/api/quo/line-stats` (per-line,
no team filter).

**How to apply:**
- `/api/quo/stats` now has an `other` bucket; unclassified calls land there
  instead of being dropped. Adding the bucket is safe for the dashboard because
  it indexes `teamStats` by fixed keys (`retention`/`nsf`/`cs`), never iterates
  all keys.
- When you need an agent's TRUE total, sum across **all** teams (including
  `other`), not a single team bucket. Samia's live-data context builds a
  "Per-Agent TOTALS (ALL lines combined)" section this way for today + month and
  is told to use it for individual-agent questions.
- If per-team accuracy matters for a specific person, the real fix is mapping
  them in `AGENT_TEAM` (quo.ts) so their calls bucket to the right team
  regardless of which line they used.
