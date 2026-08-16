const PBX_BASE_URL = "https://phonesystem.voslogic.com";

let cachedCookie = "";
let cookieExpiry = 0;
let sessionRefresh: Promise<string> | null = null;

export interface VosDashboard {
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

export interface VosAgent {
  id: number;
  name: string;
  extension: string;
  email: string;
  role: string;
  status: string;
  ringGroupIds: number[];
}

export interface VosRingGroup {
  id: number;
  name: string;
  agentIds: number[];
}

export interface VosCallRaw {
  id: number;
  direction: string;
  status: string;
  duration: number | null;
  agentId: number | null;
  agentName: string | null;
  fromNumber?: string;
  toNumber?: string;
  createdAt: string;
  ringGroupId?: number | null;
  ringGroupName?: string | null;
}

async function refreshPbxSession(): Promise<string> {
  const email = (process.env["VOSLOGIC_EMAIL"] ?? "").trim().replace(/^["']|["']$/g, "");
  const password = (process.env["VOSLOGIC_PASSWORD"] ?? "").trim().replace(/^["']|["']$/g, "");
  if (!email || !password) throw new Error("VOSLOGIC_EMAIL / VOSLOGIC_PASSWORD not set");

  const res = await fetch(`${PBX_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`VoSLogic login failed: ${res.status}`);

  const cookie = (res.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  if (!cookie) throw new Error("VoSLogic login returned no cookie");

  cachedCookie = cookie;
  cookieExpiry = Date.now() + 6 * 60 * 60 * 1000;
  return cookie;
}

async function getPbxSession(): Promise<string> {
  if (cachedCookie && Date.now() < cookieExpiry) return cachedCookie;
  sessionRefresh ??= refreshPbxSession().finally(() => {
    sessionRefresh = null;
  });
  return sessionRefresh;
}

export async function fetchPbxJson<T>(path: string): Promise<T> {
  const cookie = await getPbxSession();
  const res = await fetch(`${PBX_BASE_URL}${path}`, {
    headers: { "Accept": "application/json", "Cookie": cookie },
  });
  if (res.status === 401) {
    cachedCookie = "";
    cookieExpiry = 0;
    const refreshedCookie = await getPbxSession();
    const retry = await fetch(`${PBX_BASE_URL}${path}`, {
      headers: { "Accept": "application/json", "Cookie": refreshedCookie },
    });
    if (!retry.ok) throw new Error(`VoSLogic API error ${retry.status}`);
    return retry.json() as Promise<T>;
  }
  if (!res.ok) throw new Error(`VoSLogic API error ${res.status}`);
  return res.json() as Promise<T>;
}
