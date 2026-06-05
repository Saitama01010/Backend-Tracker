---
name: Onboarding line is a shared ring-group
description: Why per-agent response rate is degenerate on the onboarding phone line and how analytics must handle it
---

The onboarding phone line (line `PNdcJ0UEu5` = (949) 315-7441) is a **shared ring-group**: an inbound call rings every agent at once.

**Data-model consequence (not visible in code):** OpenPhone attributes a *missed* inbound call to a single line-owner "overflow" account (currently surfaces as agent name "Shahin .") rather than to whoever let it ring. That account answers 0 and dials 0 — it is purely the bucket where unanswered inbound calls land. Agents who pick up therefore show ~100% response rate, so **per-agent response rate is degenerate** and useless as a ranking key.

**How analytics must handle it:**
- Detect overflow accounts as `answered === 0 && outbound === 0 && inboundMissed > 0`; exclude them from agent ranking and from availability/gap math; sort them last; label them as overflow (not a real agent).
- Rank real agents by **workload (answered volume)** then onboarding conversion — not by response rate.
- Report response rate / missed ratio at the **line/team level** (meaningful), not per agent.

**Availability-by-hour gotcha:** summing *total* idle seconds per hour is biased toward busy hours (more calls = more gaps). Use **average idle minutes per gap** with a minimum-gap-count threshold so a lone overnight gap can't win the "most available hour".

**Timezone:** all day bucketing is America/Los_Angeles. Frontend date pickers must compute "today"/"this month" in LA (via `Intl.DateTimeFormat` `en-CA` with `timeZone`), not UTC ISO slicing, or default ranges drift by a day/month near midnight.
