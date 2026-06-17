---
name: Dashboard polling cadence
description: Which agent-dashboard queries may be slowed vs must stay real-time, and why
---

# Dashboard query polling cadence

Only `liveCalls` (`/api/quo/live`) and `vosLive` (`/api/vos/live`) are genuinely
real-time and must keep a ~15s `refetchInterval`. Everything else
(`status`/sheet loaders, `phoneStats` → `/api/quo/stats`, `calls`, `lineStats`,
`rmkSubmissions`, `readymodeStats`) is slow-changing and polls at 60s.

**Why:** `/api/quo/stats` and related call data are served from PostgreSQL, which
is only refreshed by a background OpenPhone sync every ~15 min — so polling those
at 15s did 4x the network/render churn for zero fresher data. Sheet-backed
submission stats also change slowly. The huge single-file `App.tsx` (~10k lines,
>512KB) makes constant refetch-driven re-renders expensive, and OpenPhone (`quo`)
is frequently rate-limited (429s) upstream, so fewer client calls also reduces
server retry pressure.

**How to apply:** When adding/adjusting a dashboard query, default to 60s +
`refetchOnWindowFocus: false`. Reserve 15s polling for true live-call widgets
only. The global `QueryClient` default is `refetchOnWindowFocus: false`,
`staleTime: 30s` — don't re-enable focus refetch per-query unless the data is live.
Perceived slowness is also amplified by viewing the dev preview (unminified,
Babel-deoptimised on the 500KB+ file); the published build is much faster.
