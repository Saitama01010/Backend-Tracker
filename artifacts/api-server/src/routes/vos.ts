import { Router } from "express";
import { db, phoneCallsTable } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
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

export type VosRingGroupMissed = Record<number, number>;

export interface MissedNoCallbackItem {
  id: number;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "retention" | "nsf" | "cs" | "other";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(num: string): string {
  const digits = (num ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function teamFromRingGroupName(name: string): "retention" | "nsf" | "cs" | "other" {
  const n = name.toLowerCase();
  if (n.includes("retention")) return "retention";
  if (n.includes("back") || n.includes("nsf")) return "nsf";
  if (n.includes("customer") || n.includes("support") || n === "cs" || n.includes("cs team")) return "cs";
  return "other";
}

// ─── Per-agent status breakdown ───────────────────────────────────────────────

async function fetchAgentCallsForDate(
  agentId: number,
  expectedCount: number,
  today: string,
  yesterday: string
): Promise<{
  answered: number;
  missed: number;
  voicemail: number;
  durationSeconds: number;
  lastCallAt: string | null;
  inboundToNumbers: string[];
  outboundCallbacks: Array<{ toNumber: string; createdAt: string }>;
}> {
  let answered = 0, missed = 0, voicemail = 0, durationSeconds = 0;
  let lastCallAt: string | null = null;
  const inboundToNumbers: string[] = [];
  const outboundCallbacks: Array<{ toNumber: string; createdAt: string }> = [];
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
      // Accept today OR yesterday — the VoSLogic backend uses its own local timezone
      // which may be a full day behind the server's UTC date in the late-evening hours.
      if (dateStr < yesterday) { done = true; break; }

      if (totalSeen >= cap) { done = true; break; }
      totalSeen++;

      if (call.status === "active" || call.status === "ringing") continue;

      if (!lastCallAt) lastCallAt = call.createdAt;
      if (call.status === "completed") answered++;
      if (call.status === "no-answer" || call.status === "missed") missed++;
      if (call.status === "voicemail") voicemail++;
      if (call.duration) durationSeconds += call.duration;

      if (call.direction === "inbound" && call.toNumber && call.status === "completed") {
        inboundToNumbers.push(call.toNumber);
      }

      // Collect every outbound call this agent made today for callback detection.
      // Use direction !== "inbound" to be safe regardless of the exact enum value.
      if (call.direction !== "inbound" && call.toNumber) {
        outboundCallbacks.push({ toNumber: call.toNumber, createdAt: call.createdAt });
      }
    }

    if (done) break;
    page++;
  }

  return { answered, missed, voicemail, durationSeconds, lastCallAt, inboundToNumbers, outboundCallbacks };
}

/**
 * Scan recent unfiltered call pages for:
 *  1. Inbound voicemail/no-answer (agentId=null) → ring group missed counts + individual records
 *  2. All outbound completed calls → PBX callback numbers (for missed-no-callback detection)
 */
async function scanRingGroupCalls(
  lineToRingGroupId: Map<string, number>,
  ringGroupIdToName: Map<number, string>,
  totalCallsToday: number
): Promise<{
  missedCounts: VosRingGroupMissed;
  missedRecords: Array<{ id: number; fromNumber: string; toNumber: string; createdAt: string; ringGroupId: number; ringGroupName: string }>;
  pbxOutboundCalls: Array<{ toNumber: string; createdAt: string }>;
}> {
  const missedCounts: VosRingGroupMissed = {};
  const missedRecords: Array<{ id: number; fromNumber: string; toNumber: string; createdAt: string; ringGroupId: number; ringGroupName: string }> = [];
  const pbxOutboundCalls: Array<{ toNumber: string; createdAt: string }> = [];
  // Deduplicate by call ID — some VoSLogic API pages return overlapping records
  const seenCallIds = new Set<number>();

  if (lineToRingGroupId.size === 0) return { missedCounts, missedRecords, pbxOutboundCalls };

  // Always scan at least 10 pages (1000 calls) so we cover a full day even if
  // totalCallsToday is 0 (e.g. just after UTC midnight when VoSLogic hasn't reset yet).
  const pagesToScan = Math.max(10, Math.min(20, Math.ceil((totalCallsToday * 1.5) / 100) + 2));

  for (let page = 1; page <= pagesToScan; page++) {
    const data = await vosFetch<{ calls: VosCallRaw[] }>(
      `/api/calls?limit=100&page=${page}`
    );
    if (!data.calls?.length) break;

    for (const call of data.calls) {
      // Collect PBX outbound calls for callback detection.
      // Use direction !== "inbound" to match regardless of exact enum value ("outbound"/"outgoing").
      if (call.direction !== "inbound" && call.toNumber) {
        pbxOutboundCalls.push({ toNumber: call.toNumber, createdAt: call.createdAt });
      }

      // Ring group missed: inbound, no agent, unanswered
      if (call.agentId !== null && call.agentId !== undefined) continue;
      if (call.direction !== "inbound") continue;
      if (call.status !== "voicemail" && call.status !== "no-answer" && call.status !== "missed") continue;
      if (!call.toNumber) continue;

      const rgId = lineToRingGroupId.get(call.toNumber);
      if (rgId === undefined) continue;

      // Skip duplicate call IDs (VoSLogic sometimes returns the same call on multiple pages)
      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);

      missedCounts[rgId] = (missedCounts[rgId] ?? 0) + 1;

      if (call.fromNumber) {
        missedRecords.push({
          id: call.id,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          createdAt: call.createdAt,
          ringGroupId: rgId,
          ringGroupName: ringGroupIdToName.get(rgId) ?? String(rgId),
        });
      }
    }
  }

  return { missedCounts, missedRecords, pbxOutboundCalls };
}

// ─── Call history — background-refreshed cache ───────────────────────────────

let callHistoryCache: VosCallHistoryStat[] = [];
let callHistoryFetchedAt = 0;
let callHistoryFetching = false;
let ringGroupMissedCache: VosRingGroupMissed = {};
let missedNoCallbackCache: MissedNoCallbackItem[] = [];

async function refreshCallHistory(log?: Logger): Promise<void> {
  if (callHistoryFetching) return;
  callHistoryFetching = true;
  const t0 = Date.now();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const [dashboard, agentList, ringGroups] = await Promise.all([
      vosFetch<VosDashboard>("/api/dashboard"),
      vosFetch<VosAgent[]>("/api/agents"),
      vosFetch<VosRingGroup[]>("/api/ring-groups"),
    ]);

    const nameToId = new Map<string, number>();
    for (const a of agentList) nameToId.set(a.name.trim(), a.id);

    const agentToRingGroups = new Map<number, number[]>();
    for (const rg of ringGroups) {
      for (const agentId of rg.agentIds) {
        if (!agentToRingGroups.has(agentId)) agentToRingGroups.set(agentId, []);
        agentToRingGroups.get(agentId)!.push(rg.id);
      }
    }

    const ringGroupIdToName = new Map<number, string>();
    for (const rg of ringGroups) ringGroupIdToName.set(rg.id, rg.name);

    const agents = dashboard.callsByAgent ?? [];
    const results: VosCallHistoryStat[] = [];

    const lineRingGroupCounts = new Map<string, Map<number, number>>();
    // Outbound call records collected from per-agent scans — the most complete
    // source of PBX callbacks because per-agent scans cover the full agent call list.
    const agentOutboundCallbacks: Array<{ toNumber: string; createdAt: string }> = [];

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
              outboundCallbacks: [] as Array<{ toNumber: string; createdAt: string }>,
            };
          }
          const detail = await fetchAgentCallsForDate(agentId, a.calls, today, yesterday);
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
            outboundCallbacks: detail.outboundCallbacks,
          };
        })
      );
      for (const r of batchResults) {
        const { inboundToNumbers: _, outboundCallbacks: __, ...stat } = r;
        results.push(stat satisfies VosCallHistoryStat);
        // Feed every per-agent outbound call into the callback map immediately
        // so it's available for cross-referencing after all agents are scanned.
        for (const cb of __) agentOutboundCallbacks.push(cb);
      }
    }

    const lineToRingGroupId = new Map<string, number>();
    for (const [line, rgCounts] of lineRingGroupCounts.entries()) {
      let bestRg = -1, bestCount = 0;
      for (const [rgId, count] of rgCounts.entries()) {
        if (count > bestCount) { bestRg = rgId; bestCount = count; }
      }
      if (bestRg >= 0) lineToRingGroupId.set(line, bestRg);
    }

    const scanResult = await scanRingGroupCalls(lineToRingGroupId, ringGroupIdToName, dashboard.totalCallsToday ?? 600);

    // ── Cross-reference missed records against callbacks ──────────────────────
    // Build callback lookup: normalized phone → all times an outbound call was made today
    const callbackTimes = new Map<string, Date[]>();

    const addCallback = (rawPhone: string, at: Date) => {
      const norm = normalizePhone(rawPhone);
      if (!norm) return;
      if (!callbackTimes.has(norm)) callbackTimes.set(norm, []);
      callbackTimes.get(norm)!.push(at);
    };

    // Per-agent outbound calls — most complete PBX source (full per-agent history scanned above)
    for (const c of agentOutboundCallbacks) {
      addCallback(c.toNumber, new Date(c.createdAt));
    }

    // Global scan outbound calls — supplementary, catches any agents not in dashboard.callsByAgent
    for (const c of scanResult.pbxOutboundCalls) {
      addCallback(c.toNumber, new Date(c.createdAt));
    }

    // Quo DB outbound calls — use a 36-hour window to cover any timezone offset between
    // the server (UTC) and the business's local time, ensuring no callbacks are missed.
    const window36h = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const quoOutbound = await db
      .select({ participant: phoneCallsTable.participant, createdAt: phoneCallsTable.createdAt })
      .from(phoneCallsTable)
      .where(and(eq(phoneCallsTable.direction, "outgoing"), gte(phoneCallsTable.createdAt, window36h)));

    for (const row of quoOutbound) {
      addCallback(row.participant, new Date(row.createdAt));
    }

    // Determine which missed calls had no callback after the missed call time
    const missedNoCB: MissedNoCallbackItem[] = [];
    for (const rec of scanResult.missedRecords) {
      const norm = normalizePhone(rec.fromNumber);
      const missedAt = new Date(rec.createdAt);
      const times = callbackTimes.get(norm);
      const hasCallback = times?.some((t) => t >= missedAt) ?? false;
      if (!hasCallback) {
        missedNoCB.push({
          id: rec.id,
          fromNumber: rec.fromNumber,
          toNumber: rec.toNumber,
          createdAt: rec.createdAt,
          ringGroupId: rec.ringGroupId,
          ringGroupName: rec.ringGroupName,
          team: teamFromRingGroupName(rec.ringGroupName),
        });
      }
    }

    callHistoryCache = results;
    callHistoryFetchedAt = Date.now();
    ringGroupMissedCache = scanResult.missedCounts;
    missedNoCallbackCache = missedNoCB;

    log?.info(
      {
        agents: results.length,
        ringGroupMissed: scanResult.missedCounts,
        missedNoCB: missedNoCB.length,
        lines: lineToRingGroupId.size,
        ms: Date.now() - t0,
        today,
      },
      "vos: call history refreshed"
    );
  } catch (err) {
    log?.error(err, "vos: call history refresh failed");
  } finally {
    callHistoryFetching = false;
  }
}

void refreshCallHistory();
setInterval(() => void refreshCallHistory(), 5 * 60 * 1000);

// ─── Routes ───────────────────────────────────────────────────────────────────

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

/**
 * GET /api/vos/missed-no-callback
 *
 * Returns today's missed PBX ring-group calls that had no callback
 * (neither PBX outbound nor Quo outbound) after the time of the missed call.
 * Results are from the background-refresh cache (updated every 5 min).
 */
router.get("/vos/missed-no-callback", (_req, res) => {
  res.json({ items: missedNoCallbackCache, fetchedAt: callHistoryFetchedAt });
});

router.get("/vos/live", async (req, res) => {
  try {
    const dashboard = await vosFetch<VosDashboard>("/api/dashboard");
    res.json({ liveCalls: dashboard.liveCalls ?? [], agentStatuses: dashboard.agentStatuses ?? [] });
  } catch (err) {
    req.log.error(err, "vos live error");
    res.status(500).json({ error: String(err) });
  }
});

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
