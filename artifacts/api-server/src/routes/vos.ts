import { Router } from "express";

const router = Router();

const VOS_BASE = "https://phonesystem.voslogic.com";

// Session cache — re-login only when cookie expires or request fails
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

  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("VoSLogic login returned no cookie");

  cachedCookie = cookie;
  // Cookies expire in ~30 days; re-login after 6 hours to be safe
  cookieExpiry = Date.now() + 6 * 60 * 60 * 1000;
  return cookie;
}

async function vosFetch<T>(path: string): Promise<T> {
  const cookie = await getSession();
  const res = await fetch(`${VOS_BASE}${path}`, {
    headers: { "Accept": "application/json", "Cookie": cookie },
  });
  if (res.status === 401) {
    // Session expired — clear cache and retry once
    cachedCookie = "";
    cookieExpiry = 0;
    const cookie2 = await getSession();
    const res2 = await fetch(`${VOS_BASE}${path}`, {
      headers: { "Accept": "application/json", "Cookie": cookie2 },
    });
    if (!res2.ok) throw new Error(`VoSLogic API error ${res2.status}`);
    return res2.json() as Promise<T>;
  }
  if (!res.ok) throw new Error(`VoSLogic API error ${res.status}`);
  return res.json() as Promise<T>;
}

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
  callsByAgent: {
    agentName: string;
    calls: number;
    inbound: number;
    outbound: number;
    avgDuration: number;
  }[];
  liveCalls: {
    id: number;
    direction: string;
    callerNumber: string;
    calledNumber: string;
    phoneLabel: string;
    ringGroupName: string | null;
    agentName: string | null;
    duration: number;
    startedAt: string;
  }[];
  agentStatuses: {
    id: number;
    name: string;
    extension: string;
    status: string;
    callsToday: number;
  }[];
}

interface VosAgent {
  id: number;
  name: string;
  extension: string;
  email: string;
  role: string;
  status: string;
  ringGroupIds: number[];
}

interface VosRingGroup {
  id: number;
  name: string;
  agentIds: number[];
}

// GET /api/vos/stats — dashboard stats + agent list + ring groups
router.get("/vos/stats", async (req, res) => {
  try {
    const [dashboard, agents, ringGroups] = await Promise.all([
      vosFetch<VosDashboard>("/api/dashboard"),
      vosFetch<VosAgent[]>("/api/agents"),
      vosFetch<VosRingGroup[]>("/api/ring-groups"),
    ]);
    res.json({ dashboard, agents, ringGroups });
  } catch (err) {
    req.log.error(err, "vos stats error");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/vos/live — currently active calls
router.get("/vos/live", async (req, res) => {
  try {
    const dashboard = await vosFetch<VosDashboard>("/api/dashboard");
    res.json({
      liveCalls: dashboard.liveCalls ?? [],
      agentStatuses: dashboard.agentStatuses ?? [],
    });
  } catch (err) {
    req.log.error(err, "vos live error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
