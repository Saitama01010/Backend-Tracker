import { Router } from "express";
import type { Logger } from "pino";

const router = Router();

const VOS_BASE = "https://phonesystem.voslogic.com";

// ─── Session ─────────────────────────────────────────────────────────────────

let cachedCookie = "";
let cookieExpiry = 0;

async function getSession(): Promise<string> {
  if (cachedCookie && Date.now() < cookieExpiry) return cachedCookie;
  const email = process.env["VOSLOGIC_EMAIL"];
  const password = process.env["VOSLOGIC_PASSWORD"];
  if (!email || !password) throw new Error("VOSLOGIC_EMAIL / VOSLOGIC_PASSWORD not set");
  const res = await fetch(`${VOS_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`VoSLogic login failed: ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("VoSLogic login returned no cookie");
  cachedCookie = cookie;
  cookieExpiry = Date.now() + 6 * 60 * 60 * 1000;
  return cookie;
}

async function vosFetch<T>(path: string): Promise<T> {
  const cookie = await getSession();
  const res = await fetch(`${VOS_BASE}${path}`, {
    headers: { "Accept": "application/json", "Cookie": cookie },
  });
  if (res.status === 401) {
    cachedCookie = "";
    cookieExpiry = 0;
    const cookie2 = await getSession();
    const res2 = await fetch(`${VOS_BASE}${path}`, { headers: { "Accept": "application/json", "Cookie": cookie2 } });
    if (!res2.ok) throw new Error(`VoSLogic API error ${res2.status}`);
    return res2.json() as Promise<T>;
  }
  if (!res.ok) throw new Error(`VoSLogic API error ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface VosDashboard {
  activeCalls: number;
  totalAgents: number;
  onlineAgents: number;
  availableAgents: number;
  totalCallsToday: number;
  avgDurationToday: number;
  totalInboundToday: number;
  totalOutboundToday: number;
  missedCallsToday: number;
  callsByAgent: { agentName: string; calls: number; inbound: number; outbound: number; avgDuration: number }[];
  liveCalls: { id: number; direction: string; callerNumber: string; calledNumber: string; phoneLabel: string; ringGroupName: string | null; agentName: string | null; duration: number; startedAt: string }[];
  agentStatuses: { id: number; name: string; extension: string; status: string; callsToday: number }[];
}

interface VosAgent { id: number; name: string; extension: string; email: string; role: string; status: string; ringGroupIds: number[] }
interface VosRingGroup { id: number; name: string; agentIds: number[] }

interface VosCallRaw {
  id: number;
  direction: string;
  status: string;
  duration: number | null;
  agentId: number | null;
  agentName: string | null;
  createdAt: string;
}

export interface VosCallHistoryStat {
  agentName: string;
  calls: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  durationSeconds: number;
  lastCallAt: string | null;
}

// ─── Per-agent status breakdown ───────────────────────────────────────────────

/**
 * Fetch status breakdown for a specific agent's calls today.
 *
 * Two complementary stopping criteria (whichever fires first):
 *   1. Date boundary — if createdAt < today we've left today's window (works for
 *      agents whose historical records have accurate dates).
 *   2. Count cap — stop after processing `expectedCount + buffer` calls total;
 *      this handles agents whose old records all show today's date (VoSLogic bug)
 *      by using the dashboard's already-accurate per-agent count.
 *
 * Calls are returned newest-first, so the first call seen is the most recent.
 */
async function fetchAgentCallsForDate(
  agentId: number,
  expectedCount: number, // today's call count from dashboard (our ground truth)
  today: string
): Promise<{ answered: number; missed: number; voicemail: number; durationSeconds: number; lastCallAt: string | null }> {
  let answered = 0, missed = 0, voicemail = 0, durationSeconds = 0;
  let lastCallAt: string | null = null;
  let totalSeen = 0; // all calls seen (including active/ringing)
  // Use the dashboard's call count as the cap: this is our ground truth for how many
  // calls this agent had today. Since missed/voicemail calls have agentId=null in
  // VoSLogic they won't appear in agentId-filtered results, so answered ≈ calls.
  const cap = expectedCount;
  let page = 1;

  while (page <= 20) {
    const data = await vosFetch<{ calls: VosCallRaw[] }>(
      `/api/calls?agentId=${agentId}&limit=100&page=${page}`
    );
    if (!data.calls?.length) break;

    let done = false;
    for (const call of data.calls) {
      // Date-boundary check (works when createdAt is accurate for this agent)
      const dateStr = call.createdAt.slice(0, 10);
      if (dateStr > today) continue;
      if (dateStr < today) { done = true; break; }

      // Count-cap: stop once we've consumed the expected number of today's calls
      if (totalSeen >= cap) { done = true; break; }
      totalSeen++;

      if (call.status === "active" || call.status === "ringing") continue;

      if (!lastCallAt) lastCallAt = call.createdAt; // newest-first → first = latest
      if (call.status === "completed") answered++;
      if (call.status === "no-answer" || call.status === "missed") missed++;
      if (call.status === "voicemail") voicemail++;
      if (call.duration) durationSeconds += call.duration;
    }

    if (done) break;
    page++;
  }

  return { answered, missed, voicemail, durationSeconds, lastCallAt };
}

// ─── Call history — background-refreshed cache ───────────────────────────────

let callHistoryCache: VosCallHistoryStat[] = [];
let callHistoryFetchedAt = 0;
let callHistoryFetching = false;

/**
 * Refresh today's per-agent call history.
 * Strategy:
 *   1. Fetch dashboard (for today's call counts + agent names) + agents list
 *   2. For each agent appearing in dashboard.callsByAgent, fetch their today's calls
 *      by agentId with early termination — each agent is 1-2 pages (~100-200 calls)
 *   3. Aggregate answered / missed / voicemail / durationSeconds / lastCallAt
 *   4. Concurrently process 5 agents at a time
 */
async function refreshCallHistory(log?: Logger): Promise<void> {
  if (callHistoryFetching) return;
  callHistoryFetching = true;
  const t0 = Date.now();
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Fetch dashboard (agent today-totals) and agents list (name→id map) in parallel
    const [dashboard, agentList] = await Promise.all([
      vosFetch<VosDashboard>("/api/dashboard"),
      vosFetch<VosAgent[]>("/api/agents"),
    ]);

    // Build name → id lookup
    const nameToId = new Map<string, number>();
    for (const a of agentList) nameToId.set(a.name.trim(), a.id);

    // For each agent in dashboard.callsByAgent, fetch their status breakdown
    const agents = dashboard.callsByAgent ?? [];
    const results: VosCallHistoryStat[] = [];

    const CONCURRENCY = 5;
    for (let i = 0; i < agents.length; i += CONCURRENCY) {
      const batch = agents.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (a) => {
          const agentId = nameToId.get(a.agentName.trim());
          if (agentId === undefined) {
            // No ID match — use dashboard totals only, no status breakdown
            return {
              agentName: a.agentName,
              calls: a.calls,
              inbound: a.inbound,
              outbound: a.outbound,
              answered: 0,
              missed: 0,
              voicemail: 0,
              durationSeconds: Math.round((a.avgDuration ?? 0) * a.calls),
              lastCallAt: null,
            } satisfies VosCallHistoryStat;
          }
          const detail = await fetchAgentCallsForDate(agentId, a.calls, today);
          return {
            agentName: a.agentName,
            calls: a.calls,
            inbound: a.inbound,
            outbound: a.outbound,
            ...detail,
          } satisfies VosCallHistoryStat;
        })
      );
      results.push(...batchResults);
    }

    callHistoryCache = results;
    callHistoryFetchedAt = Date.now();
    log?.info(
      { agents: results.length, ms: Date.now() - t0, today },
      "vos: call history refreshed"
    );
  } catch (err) {
    log?.error(err, "vos: call history refresh failed");
  } finally {
    callHistoryFetching = false;
  }
}

// Kick off immediately on startup, then every 5 minutes
void refreshCallHistory();
setInterval(() => void refreshCallHistory(), 5 * 60 * 1000);

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/vos/stats
 *
 * Returns cached per-agent call history (answered/missed/voicemail/duration/lastCallAt)
 * from the background refresh job, plus live dashboard + agents + ring-groups.
 */
router.get("/vos/stats", async (req, res) => {
  try {
    const [agents, ringGroups, dashboard] = await Promise.all([
      vosFetch<VosAgent[]>("/api/agents"),
      vosFetch<VosRingGroup[]>("/api/ring-groups"),
      vosFetch<VosDashboard>("/api/dashboard"),
    ]);

    // While the background job hasn't completed yet, fall back to dashboard callsByAgent
    // enriched with estimated duration (no status breakdown yet).
    const callHistory: VosCallHistoryStat[] =
      callHistoryCache.length > 0
        ? callHistoryCache
        : (dashboard.callsByAgent ?? []).map((a) => ({
            agentName: a.agentName,
            calls: a.calls,
            inbound: a.inbound,
            outbound: a.outbound,
            answered: 0,
            missed: 0,
            voicemail: 0,
            durationSeconds: Math.round((a.avgDuration ?? 0) * a.calls),
            lastCallAt: null,
          }));

    res.json({ dashboard, agents, ringGroups, callHistory, callHistoryFetchedAt });
  } catch (err) {
    req.log.error(err, "vos stats error");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/vos/live — currently active calls (fast — just dashboard)
router.get("/vos/live", async (req, res) => {
  try {
    const dashboard = await vosFetch<VosDashboard>("/api/dashboard");
    res.json({ liveCalls: dashboard.liveCalls ?? [], agentStatuses: dashboard.agentStatuses ?? [] });
  } catch (err) {
    req.log.error(err, "vos live error");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/vos/debug/calls?agentId=X&limit=N — raw call records for inspection
router.get("/vos/debug/calls", async (req, res) => {
  try {
    const agentId = req.query["agentId"] ? `&agentId=${req.query["agentId"]}` : "";
    const limit = req.query["limit"] ?? 5;
    const data = await vosFetch<{ calls: VosCallRaw[]; total: number }>(
      `/api/calls?limit=${limit}&page=1${agentId}`
    );
    res.json({ total: data.total, calls: data.calls });
  } catch (err) {
    req.log.error(err, "vos debug error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
