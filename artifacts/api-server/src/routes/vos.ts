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
  fromNumber?: string;
  toNumber?: string;
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

// Ring group missed = voicemail/no-answer calls counted per ring group ID
export type VosRingGroupMissed = Record<number, number>;

// ─── Per-agent status breakdown ───────────────────────────────────────────────

/**
 * Fetch status breakdown for a specific agent's calls today.
 * Also collects inbound toNumber values (the ring group phone lines this agent
 * receives calls on) so the caller can build a line → ring group mapping.
 */
async function fetchAgentCallsForDate(
  agentId: number,
  expectedCount: number,
  today: string
): Promise<{
  answered: number;
  missed: number;
  voicemail: number;
  durationSeconds: number;
  lastCallAt: string | null;
  inboundToNumbers: string[];
}> {
  let answered = 0, missed = 0, voicemail = 0, durationSeconds = 0;
  let lastCallAt: string | null = null;
  const inboundToNumbers: string[] = [];
  let totalSeen = 0;
  const cap = expectedCount;
  let page = 1;

  while (page <= 20) {
    const data = await vosFetch<{ calls: VosCallRaw[] }>(
      `/api/calls?agentId=${agentId}&limit=100&page=${page}`
    );
    if (!data.calls?.length) break;

    let done = false;
    for (const call of data.calls) {
      const dateStr = call.createdAt.slice(0, 10);
      if (dateStr > today) continue;
      if (dateStr < today) { done = true; break; }

      if (totalSeen >= cap) { done = true; break; }
      totalSeen++;

      if (call.status === "active" || call.status === "ringing") continue;

      if (!lastCallAt) lastCallAt = call.createdAt;
      if (call.status === "completed") answered++;
      if (call.status === "no-answer" || call.status === "missed") missed++;
      if (call.status === "voicemail") voicemail++;
      if (call.duration) durationSeconds += call.duration;

      // Collect inbound lines to build ring group → phone line mapping
      if (call.direction === "inbound" && call.toNumber && call.status === "completed") {
        inboundToNumbers.push(call.toNumber);
      }
    }

    if (done) break;
    page++;
  }

  return { answered, missed, voicemail, durationSeconds, lastCallAt, inboundToNumbers };
}

/**
 * Scan recent unfiltered call pages for voicemail/no-answer calls (agentId=null)
 * and count them per ring group using the provided phone line → ring group ID map.
 *
 * Since ALL historical calls show today's date in VoSLogic (a VoSLogic bug),
 * we cannot rely on date-based termination. Instead we scan a fixed window of
 * pages that covers a full day's call volume across all ring groups (~10 pages).
 */
async function fetchRingGroupMissed(
  lineToRingGroupId: Map<string, number>,
  totalCallsToday: number
): Promise<VosRingGroupMissed> {
  const missed: VosRingGroupMissed = {};
  if (lineToRingGroupId.size === 0) return missed;

  // Scan enough pages to cover today's calls. Each page = 100 records.
  // Total daily volume (answered + voicemail) is typically 800-1000 records.
  // We also cap using the dashboard's totalCallsToday as a guide.
  const pagesToScan = Math.min(12, Math.ceil((totalCallsToday * 1.5) / 100) + 2);

  for (let page = 1; page <= pagesToScan; page++) {
    const data = await vosFetch<{ calls: VosCallRaw[] }>(
      `/api/calls?limit=100&page=${page}`
    );
    if (!data.calls?.length) break;

    for (const call of data.calls) {
      // Only count unanswered inbound calls with no agent
      if (call.agentId !== null && call.agentId !== undefined) continue;
      if (call.direction !== "inbound") continue;
      if (call.status !== "voicemail" && call.status !== "no-answer" && call.status !== "missed") continue;

      const line = call.toNumber;
      if (!line) continue;

      const rgId = lineToRingGroupId.get(line);
      if (rgId !== undefined) {
        missed[rgId] = (missed[rgId] ?? 0) + 1;
      }
    }
  }

  return missed;
}

// ─── Call history — background-refreshed cache ───────────────────────────────

let callHistoryCache: VosCallHistoryStat[] = [];
let callHistoryFetchedAt = 0;
let callHistoryFetching = false;
let ringGroupMissedCache: VosRingGroupMissed = {};

/**
 * Refresh today's per-agent call history plus ring group missed counts.
 *
 * Strategy:
 *   1. Fetch dashboard + agents list + ring groups in parallel
 *   2. For each agent in dashboard.callsByAgent, fetch their calls to get status breakdown.
 *      Also collect the inbound toNumber values (= ring group phone lines).
 *   3. Build a phone line → ring group ID map from the collected toNumbers.
 *   4. Scan unfiltered recent call pages for voicemail/no-answer calls; match by toNumber
 *      to attribute them to the correct ring group.
 *   5. Cache everything.
 */
async function refreshCallHistory(log?: Logger): Promise<void> {
  if (callHistoryFetching) return;
  callHistoryFetching = true;
  const t0 = Date.now();
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [dashboard, agentList, ringGroups] = await Promise.all([
      vosFetch<VosDashboard>("/api/dashboard"),
      vosFetch<VosAgent[]>("/api/agents"),
      vosFetch<VosRingGroup[]>("/api/ring-groups"),
    ]);

    // Build name → id lookup
    const nameToId = new Map<string, number>();
    for (const a of agentList) nameToId.set(a.name.trim(), a.id);

    // Build agentId → ring group IDs lookup
    const agentToRingGroups = new Map<number, number[]>();
    for (const rg of ringGroups) {
      for (const agentId of rg.agentIds) {
        if (!agentToRingGroups.has(agentId)) agentToRingGroups.set(agentId, []);
        agentToRingGroups.get(agentId)!.push(rg.id);
      }
    }

    const agents = dashboard.callsByAgent ?? [];
    const results: VosCallHistoryStat[] = [];

    // Collect inbound phone lines per ring group while fetching per-agent data
    // lineToRingGroupId: phone number string → ring group ID (first ring group wins)
    const lineRingGroupCounts = new Map<string, Map<number, number>>();

    const CONCURRENCY = 5;
    for (let i = 0; i < agents.length; i += CONCURRENCY) {
      const batch = agents.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (a) => {
          const agentId = nameToId.get(a.agentName.trim());
          if (agentId === undefined) {
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
              inboundToNumbers: [] as string[],
            };
          }
          const detail = await fetchAgentCallsForDate(agentId, a.calls, today);
          // Associate collected phone lines with this agent's ring groups
          const rgIds = agentToRingGroups.get(agentId) ?? [];
          for (const line of detail.inboundToNumbers) {
            if (!lineRingGroupCounts.has(line)) lineRingGroupCounts.set(line, new Map());
            for (const rgId of rgIds) {
              const m = lineRingGroupCounts.get(line)!;
              m.set(rgId, (m.get(rgId) ?? 0) + 1);
            }
          }
          return {
            agentName: a.agentName,
            calls: a.calls,
            inbound: a.inbound,
            outbound: a.outbound,
            answered: detail.answered,
            missed: detail.missed,
            voicemail: detail.voicemail,
            durationSeconds: detail.durationSeconds,
            lastCallAt: detail.lastCallAt,
            inboundToNumbers: detail.inboundToNumbers,
          };
        })
      );
      for (const r of batchResults) {
        const { inboundToNumbers: _, ...stat } = r;
        results.push(stat satisfies VosCallHistoryStat);
      }
    }

    // Build best phone line → ring group mapping (most-common ring group per line wins)
    const lineToRingGroupId = new Map<string, number>();
    for (const [line, rgCounts] of lineRingGroupCounts.entries()) {
      let bestRg = -1, bestCount = 0;
      for (const [rgId, count] of rgCounts.entries()) {
        if (count > bestCount) { bestRg = rgId; bestCount = count; }
      }
      if (bestRg >= 0) lineToRingGroupId.set(line, bestRg);
    }

    // Scan recent call pages for ring group voicemail/missed counts
    const rgMissed = await fetchRingGroupMissed(lineToRingGroupId, dashboard.totalCallsToday ?? 600);

    callHistoryCache = results;
    callHistoryFetchedAt = Date.now();
    ringGroupMissedCache = rgMissed;

    log?.info(
      { agents: results.length, ringGroupMissed: rgMissed, lines: lineToRingGroupId.size, ms: Date.now() - t0, today },
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
 * from the background refresh job, plus live dashboard + agents + ring-groups +
 * ring group missed call counts.
 */
router.get("/vos/stats", async (req, res) => {
  try {
    const [agents, ringGroups, dashboard] = await Promise.all([
      vosFetch<VosAgent[]>("/api/agents"),
      vosFetch<VosRingGroup[]>("/api/ring-groups"),
      vosFetch<VosDashboard>("/api/dashboard"),
    ]);

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

    res.json({
      dashboard,
      agents,
      ringGroups,
      callHistory,
      callHistoryFetchedAt,
      ringGroupMissed: ringGroupMissedCache,
    });
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
