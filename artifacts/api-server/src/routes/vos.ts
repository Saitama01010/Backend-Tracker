import { Router } from "express";

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

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/vos/stats
 *
 * Returns today's per-agent call stats derived from:
 *   - dashboard.callsByAgent  → calls / inbound / outbound / avgDuration (today-accurate)
 *   - /api/calls page 1       → lastCallAt for recently active agents
 *
 * Note: VoSLogic's /api/calls endpoint ignores all query-string filters
 * (agentId, status, date) and returns all 92k+ records unfiltered — so
 * per-record scanning is infeasible. The dashboard is the only reliable
 * source of today's per-agent totals.
 */
router.get("/vos/stats", async (req, res) => {
  try {
    const [agents, ringGroups, dashboard, page1] = await Promise.all([
      vosFetch<VosAgent[]>("/api/agents"),
      vosFetch<VosRingGroup[]>("/api/ring-groups"),
      vosFetch<VosDashboard>("/api/dashboard"),
      vosFetch<{ calls: VosCallRaw[] }>("/api/calls?limit=100&page=1"),
    ]);

    // Build lastCallAt per agent from the 100 most-recent calls (newest first)
    const lastCallByAgent = new Map<string, string>();
    for (const call of page1.calls ?? []) {
      const name = (call.agentName ?? "").trim();
      if (name && !lastCallByAgent.has(name)) {
        lastCallByAgent.set(name, call.createdAt);
      }
    }

    // Enrich dashboard callsByAgent with durationSeconds + lastCallAt
    const callHistory: VosCallHistoryStat[] = (dashboard.callsByAgent ?? []).map((a) => ({
      agentName: a.agentName,
      calls: a.calls,
      inbound: a.inbound,
      outbound: a.outbound,
      answered: 0,  // VoSLogic /api/calls filter is broken — cannot compute per-agent status breakdown
      missed: 0,
      voicemail: 0,
      durationSeconds: Math.round((a.avgDuration ?? 0) * a.calls),
      lastCallAt: lastCallByAgent.get(a.agentName) ?? null,
    }));

    res.json({ dashboard, agents, ringGroups, callHistory });
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

// GET /api/vos/debug/calls — first-page raw call records (for inspection)
router.get("/vos/debug/calls", async (req, res) => {
  try {
    const data = await vosFetch<{ calls: VosCallRaw[]; total: number }>("/api/calls?limit=5&page=1");
    res.json({ total: data.total, calls: data.calls });
  } catch (err) {
    req.log.error(err, "vos debug error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
