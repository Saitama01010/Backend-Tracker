import { Router } from "express";
import { db, phoneCallsTable, pbxMissedCallsTable } from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { logger as rootLogger } from "../lib/logger";
import { getBlockedNumbers } from "../lib/blockedNumbers.js";

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
  // VoSLogic may include ring group info directly on call records
  ringGroupId?: number | null;
  ringGroupName?: string | null;
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
  firstCallAt: string | null;
}

export type VosRingGroupMissed = Record<number, number>;

export interface MissedNoCallbackItem {
  id: string | number;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "retention" | "nsf" | "cs" | "other";
  source: "pbx" | "quo";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(num: string): string {
  const digits = (num ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// Ring groups whose missed calls should never appear in the missed-no-callback panel.
const EXCLUDED_RING_GROUPS = new Set(["MX Retention"]);

// ─── Fetch our own OpenPhone line numbers ─────────────────────────────────────

async function fetchQuoLineNumbers(): Promise<Set<string>> {
  const key = process.env["QUO_API_KEY"];
  if (!key) return new Set();
  try {
    const res = await fetch("https://api.openphone.com/v1/phone-numbers", {
      headers: { Authorization: key, Accept: "application/json" },
    });
    if (!res.ok) return new Set();
    const data = (await res.json()) as { data: { number?: string }[] };
    const nums = new Set<string>();
    for (const line of data.data ?? []) {
      if (line.number) nums.add(normalizePhone(line.number));
    }
    return nums;
  } catch {
    return new Set();
  }
}

// Only these Quo/OpenPhone line names are team-shared lines.
// Personal agent lines (e.g. "Rick Miller RT OB", "Jenny NSF") are excluded.
const TEAM_QUO_LINES = ["Retention", "CS Team", "Main NSF"];

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
  firstCallAt: string | null;
  inboundToNumbers: string[];
  outboundCallbacks: Array<{ toNumber: string; createdAt: string }>;
  inboundAnsweredFrom: Array<{ fromNumber: string; createdAt: string }>;
}> {
  let answered = 0, missed = 0, voicemail = 0, durationSeconds = 0;
  let lastCallAt: string | null = null;
  let firstCallAt: string | null = null;
  const inboundToNumbers: string[] = [];
  const outboundCallbacks: Array<{ toNumber: string; createdAt: string }> = [];
  const inboundAnsweredFrom: Array<{ fromNumber: string; createdAt: string }> = [];
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

      const callEndAt = call.duration ? new Date(new Date(call.createdAt).getTime() + call.duration * 1000).toISOString() : call.createdAt;
      if (!lastCallAt) lastCallAt = callEndAt;
      if (callEndAt > lastCallAt) lastCallAt = callEndAt;
      // Track earliest call (API returns newest-first, so the last one seen is earliest)
      if (!firstCallAt || call.createdAt < firstCallAt) firstCallAt = call.createdAt;
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

      // Also collect inbound answered calls — if the customer called back and was answered
      // that counts as resolved too (fromNumber = customer's number).
      if (call.direction === "inbound" && call.fromNumber && call.status === "completed") {
        inboundAnsweredFrom.push({ fromNumber: call.fromNumber, createdAt: call.createdAt });
      }
    }

    if (done) break;
    page++;
  }

  return { answered, missed, voicemail, durationSeconds, lastCallAt, firstCallAt, inboundToNumbers, outboundCallbacks, inboundAnsweredFrom };
}

/**
 * Scan recent unfiltered call pages for:
 *  1. Inbound voicemail/no-answer (agentId=null) → ring group missed counts + individual records
 *  2. All outbound completed calls → PBX callback numbers (for missed-no-callback detection)
 */
async function scanRingGroupCalls(
  lineToRingGroupId: Map<string, number>,
  ringGroupIdToName: Map<number, string>,
  totalCallsToday: number,
  agentToRingGroups: Map<number, number[]>,
  internalNumbers: Set<string>
): Promise<{
  missedCounts: VosRingGroupMissed;
  missedRecords: Array<{ id: number; fromNumber: string; toNumber: string; createdAt: string; ringGroupId: number; ringGroupName: string }>;
  pbxOutboundCalls: Array<{ toNumber: string; createdAt: string }>;
}> {
  const blocklist = await getBlockedNumbers();
  const missedCounts: VosRingGroupMissed = {};
  const missedRecords: Array<{ id: number; fromNumber: string; toNumber: string; createdAt: string; ringGroupId: number; ringGroupName: string }> = [];
  const pbxOutboundCalls: Array<{ toNumber: string; createdAt: string }> = [];
  const seenCallIds = new Set<number>();

  const pagesToScan = Math.max(10, Math.min(20, Math.ceil((totalCallsToday * 1.5) / 100) + 2));

  // Layer 1: start with per-agent-derived map
  // Layer 2: merge persistent cache so previously-learned mappings survive days with no answered calls
  const lineMap = new Map(lineToRingGroupId);
  for (const [line, rgId] of persistentLineRgMap) {
    if (!lineMap.has(line)) lineMap.set(line, rgId);
  }

  // Helper: record a new line→ring group mapping into both lineMap and the persistent cache
  const learnLine = (line: string, rgId: number) => {
    if (!lineMap.has(line)) lineMap.set(line, rgId);
    if (!persistentLineRgMap.has(line)) persistentLineRgMap.set(line, rgId);
  };

  // Calls whose toNumber wasn't in lineMap when first seen — retried after full scan
  const pendingMissed: VosCallRaw[] = [];

  for (let page = 1; page <= pagesToScan; page++) {
    const data = await vosFetch<{ calls: VosCallRaw[] }>(
      `/api/calls?limit=100&page=${page}`
    );
    if (!data.calls?.length) break;

    for (const call of data.calls) {
      if (call.direction !== "inbound" && call.toNumber) {
        pbxOutboundCalls.push({ toNumber: call.toNumber, createdAt: call.createdAt });
      }

      // Layer 3a: if the API returns ringGroupId directly on the call record, learn it immediately
      if (call.toNumber && call.ringGroupId != null && ringGroupIdToName.has(call.ringGroupId)) {
        learnLine(call.toNumber, call.ringGroupId);
      }

      // Layer 3b: seed from answered inbound calls via agent→ring group membership
      if (
        call.direction === "inbound" &&
        call.agentId != null &&
        call.toNumber
      ) {
        const rgIds = agentToRingGroups.get(call.agentId);
        if (rgIds?.length) learnLine(call.toNumber, rgIds[0]);
      }

      // Ring group missed: inbound, no agent, unanswered
      if (call.agentId != null) continue;
      if (call.direction !== "inbound") continue;
      if (call.status !== "voicemail" && call.status !== "no-answer" && call.status !== "missed") continue;
      if (!call.toNumber) continue;

      // Layer 3c: if the missed call itself carries a ringGroupId, learn it now
      if (call.ringGroupId != null && ringGroupIdToName.has(call.ringGroupId)) {
        learnLine(call.toNumber, call.ringGroupId);
      }
      // Layer 3d: if the missed call has a ringGroupName, resolve it to an id
      if (call.ringGroupName && !lineMap.has(call.toNumber)) {
        for (const [rgId, rgName] of ringGroupIdToName) {
          if (rgName === call.ringGroupName) { learnLine(call.toNumber, rgId); break; }
        }
      }

      const rgId = lineMap.get(call.toNumber);
      if (rgId === undefined) {
        pendingMissed.push(call);
        continue;
      }

      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);
      const rgName = ringGroupIdToName.get(rgId) ?? String(rgId);
      missedCounts[rgId] = (missedCounts[rgId] ?? 0) + 1;
      if (call.fromNumber && !EXCLUDED_RING_GROUPS.has(rgName) && !blocklist.has(call.fromNumber) && !internalNumbers.has(normalizePhone(call.fromNumber))) {
        missedRecords.push({
          id: call.id,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          createdAt: call.createdAt,
          ringGroupId: rgId,
          ringGroupName: rgName,
        });
      }
    }
  }

  // Second pass: retry calls that were pending because their line wasn't known yet
  for (const call of pendingMissed) {
    if (!call.toNumber || !call.fromNumber) continue;
    if (blocklist.has(call.fromNumber)) continue;
    if (internalNumbers.has(normalizePhone(call.fromNumber))) continue;
    const rgId = lineMap.get(call.toNumber);
    if (rgId === undefined) continue;
    const rgName = ringGroupIdToName.get(rgId) ?? String(rgId);
    if (EXCLUDED_RING_GROUPS.has(rgName)) continue;
    if (seenCallIds.has(call.id)) continue;
    seenCallIds.add(call.id);
    missedCounts[rgId] = (missedCounts[rgId] ?? 0) + 1;
    missedRecords.push({
      id: call.id,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      createdAt: call.createdAt,
      ringGroupId: rgId,
      ringGroupName: rgName,
    });
  }

  return { missedCounts, missedRecords, pbxOutboundCalls };
}

// ─── Call history — background-refreshed cache ───────────────────────────────

// Persistent line→ring group map: accumulates across refreshes within a server session.
// Once a mapping is learned (e.g. +19498210062 → ring group 4) it is never lost, so
// ring groups with no answered calls on a given day still get their missed calls counted.
const persistentLineRgMap = new Map<string, number>();

let callHistoryCache: VosCallHistoryStat[] = [];
export function getCallHistoryCache(): VosCallHistoryStat[] { return callHistoryCache; }
let callHistoryFetchedAt = 0;
let callHistoryFetching = false;
let ringGroupMissedCache: VosRingGroupMissed = {};
let missedNoCallbackCache: MissedNoCallbackItem[] = [];
let ringGroupNameCache = new Map<number, string>(); // rgId → name, updated each refresh

// Cumulative ring group missed counts — survive across refreshes within a server session.
// VoSLogic's global /api/calls endpoint doesn't paginate (always returns the same recent
// snapshot), so each refresh only sees the latest ~100 calls. By accumulating counts via
// seenMissedCallIds we build up the true daily total across all 15-minute refresh cycles.
const cumulativeRingGroupMissed: VosRingGroupMissed = {};
const seenMissedCallIds = new Set<number>();
let cumulativeDate = ""; // reset accumulators when date changes (midnight rollover)
// Per-hour PBX missed breakdown (LA timezone), keyed by hour 0–23.
const cumulativeMissedByHour: Record<number, { retention: number; cs: number; nsf: number }> = {};

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
    for (const rg of ringGroups) {
      ringGroupIdToName.set(rg.id, rg.name);
      ringGroupNameCache.set(rg.id, rg.name);
    }

    const agents = dashboard.callsByAgent ?? [];
    const results: VosCallHistoryStat[] = [];

    const lineRingGroupCounts = new Map<string, Map<number, number>>();
    // Outbound call records collected from per-agent scans — the most complete
    // source of PBX callbacks because per-agent scans cover the full agent call list.
    const agentOutboundCallbacks: Array<{ toNumber: string; createdAt: string }> = [];
    const agentInboundAnswered: Array<{ fromNumber: string; createdAt: string }> = [];

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
              firstCallAt: null,
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
            firstCallAt: detail.firstCallAt,
            inboundToNumbers: detail.inboundToNumbers,
            outboundCallbacks: detail.outboundCallbacks,
            inboundAnsweredFrom: detail.inboundAnsweredFrom,
          };
        })
      );
      for (const r of batchResults) {
        const { inboundToNumbers: _, outboundCallbacks: __, inboundAnsweredFrom: _ia, ...stat } = r;
        results.push(stat satisfies VosCallHistoryStat);
        // Feed every per-agent outbound call into the callback map immediately
        // so it's available for cross-referencing after all agents are scanned.
        for (const cb of __) agentOutboundCallbacks.push(cb);
        // Inbound answered calls also resolve a missed call (customer called back in).
        for (const ia of _ia) agentInboundAnswered.push(ia);
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

    // ── Probe to build complete line→ring group map ────────────────────────────
    // For each ring group, probe every member agent whose inbound lines aren't
    // yet in the map. This covers agents who had voicemail-only days (no answered
    // calls → not in callsByAgent → lines never learned from per-agent scan).
    // Uses persistentLineRgMap so mappings survive across refreshes.
    const linesAlreadyMapped = new Set(lineToRingGroupId.keys());
    const probeAgentIds = new Set<number>(); // avoid duplicate probes across ring groups

    for (const rg of ringGroups) {
      for (const agentId of rg.agentIds) {
        // Skip if EVERY line for this agent is already mapped to this ring group
        const knownLinesForRg = [...persistentLineRgMap.entries()]
          .filter(([, rgId]) => rgId === rg.id)
          .map(([line]) => line);
        if (knownLinesForRg.length > 0 && linesAlreadyMapped.has(knownLinesForRg[0])) continue;
        if (probeAgentIds.has(agentId)) continue;
        probeAgentIds.add(agentId);
      }
    }

    // Build a map of agentId → ring group id for probe attribution
    const agentIdToRgId = new Map<number, number>();
    for (const rg of ringGroups) {
      for (const agentId of rg.agentIds) {
        if (!agentIdToRgId.has(agentId)) agentIdToRgId.set(agentId, rg.id);
      }
    }

    const probeTasks: Promise<void>[] = [];
    for (const agentId of probeAgentIds) {
      const rgId = agentIdToRgId.get(agentId);
      if (rgId == null) continue;
      probeTasks.push((async () => {
        try {
          const data = await vosFetch<{ calls: VosCallRaw[] }>(
            `/api/calls?agentId=${agentId}&limit=100&page=1`
          );
          for (const call of data.calls ?? []) {
            if (call.direction === "inbound" && call.toNumber && !persistentLineRgMap.has(call.toNumber)) {
              lineToRingGroupId.set(call.toNumber, rgId);
              persistentLineRgMap.set(call.toNumber, rgId);
            }
          }
        } catch { /* ignore probe failures */ }
      })());
    }
    if (probeTasks.length > 0) await Promise.all(probeTasks);

    // Build a set of all our own internal numbers (PBX lines + OpenPhone lines).
    // Any missed call FROM one of these numbers is an internal call and should be excluded.
    const quoLineNumbers = await fetchQuoLineNumbers();
    const internalNumbers = new Set<string>([
      ...[...lineToRingGroupId.keys()].map(normalizePhone),
      ...quoLineNumbers,
    ]);

    const scanResult = await scanRingGroupCalls(lineToRingGroupId, ringGroupIdToName, dashboard.totalCallsToday ?? 600, agentToRingGroups, internalNumbers);

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

    // Per-agent inbound answered calls — customer called back in and was handled.
    // fromNumber is the customer's number, so it resolves the missed call for that number.
    for (const c of agentInboundAnswered) {
      addCallback(c.fromNumber, new Date(c.createdAt));
    }

    // Global scan outbound calls — supplementary, catches any agents not in dashboard.callsByAgent
    for (const c of scanResult.pbxOutboundCalls) {
      addCallback(c.toNumber, new Date(c.createdAt));
    }

    // Quo DB outbound calls — use a 36-hour window to cover any timezone offset between
    // the server (UTC) and the business's local time, ensuring no callbacks are missed.
    const window36h = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const [quoOutbound, quoInboundAnswered] = await Promise.all([
      db
        .select({ participant: phoneCallsTable.participant, createdAt: phoneCallsTable.createdAt })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "outgoing"), gte(phoneCallsTable.createdAt, window36h))),
      // Inbound answered Quo calls: customer called us on OpenPhone and was handled.
      db
        .select({ participant: phoneCallsTable.participant, createdAt: phoneCallsTable.createdAt })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "incoming"), eq(phoneCallsTable.status, "completed"), gte(phoneCallsTable.createdAt, window36h))),
    ]);

    for (const row of quoOutbound) {
      addCallback(row.participant, new Date(row.createdAt));
    }
    for (const row of quoInboundAnswered) {
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
          id: String(rec.id),
          fromNumber: rec.fromNumber,
          toNumber: rec.toNumber,
          createdAt: rec.createdAt,
          ringGroupId: rec.ringGroupId,
          ringGroupName: rec.ringGroupName,
          team: teamFromRingGroupName(rec.ringGroupName),
          source: "pbx",
        });
      }
    }

    // Quo (OpenPhone) missed calls — reuse the same callbackTimes map already built above
    const quoMissed = await db
      .select({
        participant: phoneCallsTable.participant,
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        status: phoneCallsTable.status,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(
        and(
          eq(phoneCallsTable.direction, "incoming"),
          inArray(phoneCallsTable.status, ["no-answer", "voicemail", "missed", "voicemail-brief"]),
          gte(phoneCallsTable.createdAt, window36h),
          inArray(phoneCallsTable.lineName, TEAM_QUO_LINES)
        )
      );

    const blocklist = await getBlockedNumbers();
    for (const row of quoMissed) {
      if (blocklist.has(row.participant)) continue;
      if (/[a-zA-Z]/.test(row.participant)) continue; // skip internal line-name participants
      if (internalNumbers.has(normalizePhone(row.participant))) continue; // skip our own line numbers
      const norm = normalizePhone(row.participant);
      const missedAt = new Date(row.createdAt);
      const times = callbackTimes.get(norm);
      const hasCallback = times?.some((t) => t >= missedAt) ?? false;
      if (!hasCallback) {
        const t = row.lineTeam;
        const team: MissedNoCallbackItem["team"] =
          t === "retention" || t === "nsf" || t === "cs" ? t : "other";
        missedNoCB.push({
          id: `quo-${norm}-${row.createdAt.toISOString()}`,
          fromNumber: row.participant,
          toNumber: row.lineName,
          createdAt: row.createdAt.toISOString(),
          ringGroupId: -1,
          ringGroupName: "OpenPhone",
          team,
          source: "quo",
        });
      }
    }

    // ── Accumulate ring group missed counts across refreshes ──────────────────
    // Reset if date has changed (midnight rollover) to avoid counting yesterday's calls.
    if (cumulativeDate !== today) {
      cumulativeDate = today;
      for (const k of Object.keys(cumulativeRingGroupMissed)) delete cumulativeRingGroupMissed[k as unknown as number];
      for (const k of Object.keys(cumulativeMissedByHour)) delete cumulativeMissedByHour[k as unknown as number];
      seenMissedCallIds.clear();
    }
    // Merge new missed records into cumulative map, deduplicating by call ID.
    let newCount = 0;
    const toUpsert: typeof pbxMissedCallsTable.$inferInsert[] = [];
    for (const rec of scanResult.missedRecords) {
      if (seenMissedCallIds.has(rec.id)) continue;
      seenMissedCallIds.add(rec.id);
      cumulativeRingGroupMissed[rec.ringGroupId] = (cumulativeRingGroupMissed[rec.ringGroupId] ?? 0) + 1;
      // Also bucket by LA hour for the hourly breakdown table.
      const team = teamFromRingGroupName(rec.ringGroupName);
      if (team !== "other") {
        const h = parseInt(
          new Date(rec.createdAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false })
        );
        if (!cumulativeMissedByHour[h]) cumulativeMissedByHour[h] = { retention: 0, cs: 0, nsf: 0 };
        cumulativeMissedByHour[h][team]++;
      }
      toUpsert.push({
        id: rec.id,
        fromNumber: rec.fromNumber,
        toNumber: rec.toNumber,
        ringGroupId: rec.ringGroupId,
        ringGroupName: rec.ringGroupName,
        team: teamFromRingGroupName(rec.ringGroupName),
        createdAt: new Date(rec.createdAt),
      });
      newCount++;
    }
    // Persist new PBX missed calls so historical dates show correct PBX counts.
    if (toUpsert.length > 0) {
      await db.insert(pbxMissedCallsTable)
        .values(toUpsert)
        .onConflictDoNothing();
    }

    callHistoryCache = results;
    callHistoryFetchedAt = Date.now();
    ringGroupMissedCache = { ...cumulativeRingGroupMissed };
    missedNoCallbackCache = missedNoCB;

    log?.info(
      {
        agents: results.length,
        ringGroupMissed: ringGroupMissedCache,
        newMissedThisCycle: newCount,
        totalMissedAccumulated: seenMissedCallIds.size,
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

void refreshCallHistory(rootLogger);
setInterval(() => void refreshCallHistory(rootLogger), 2 * 60 * 1000);

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post("/vos/refresh", (_req, res) => {
  void refreshCallHistory(rootLogger);
  res.json({ ok: true });
});

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
            firstCallAt: null,
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
 * When the full PBX cache is ready, returns combined PBX+Quo results.
 * When the PBX scan is still warming up, returns Quo-DB-only results immediately.
 */
router.get("/vos/missed-no-callback", async (req, res) => {
  // Fast path: full cache is ready
  if (callHistoryFetchedAt > 0) {
    return res.json({ items: missedNoCallbackCache, fetchedAt: callHistoryFetchedAt });
  }
  // PBX scan still in progress — serve Quo DB-only results so the page isn't empty
  try {
    const window36h = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const [quoMissed, quoOutbound] = await Promise.all([
      db
        .select({
          participant: phoneCallsTable.participant,
          lineTeam: phoneCallsTable.lineTeam,
          lineName: phoneCallsTable.lineName,
          status: phoneCallsTable.status,
          createdAt: phoneCallsTable.createdAt,
        })
        .from(phoneCallsTable)
        .where(
          and(
            eq(phoneCallsTable.direction, "incoming"),
            inArray(phoneCallsTable.status, ["no-answer", "voicemail", "missed", "voicemail-brief"]),
            gte(phoneCallsTable.createdAt, window36h),
            inArray(phoneCallsTable.lineName, TEAM_QUO_LINES)
          )
        ),
      db
        .select({ participant: phoneCallsTable.participant, createdAt: phoneCallsTable.createdAt })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "outgoing"), gte(phoneCallsTable.createdAt, window36h))),
    ]);

    const callbackTimes = new Map<string, Date[]>();
    for (const row of quoOutbound) {
      const norm = normalizePhone(row.participant);
      if (!norm) continue;
      if (!callbackTimes.has(norm)) callbackTimes.set(norm, []);
      callbackTimes.get(norm)!.push(new Date(row.createdAt));
    }

    const blocklist = await getBlockedNumbers();
    const items: MissedNoCallbackItem[] = [];
    for (const row of quoMissed) {
      if (blocklist.has(row.participant)) continue;
      if (/[a-zA-Z]/.test(row.participant)) continue; // skip internal line-name participants
      const norm = normalizePhone(row.participant);
      const missedAt = new Date(row.createdAt);
      const times = callbackTimes.get(norm);
      const hasCallback = times?.some((t) => t >= missedAt) ?? false;
      if (!hasCallback) {
        const t = row.lineTeam;
        const team: MissedNoCallbackItem["team"] =
          t === "retention" || t === "nsf" || t === "cs" ? t : "other";
        items.push({
          id: `quo-${norm}-${row.createdAt.toISOString()}`,
          fromNumber: row.participant,
          toNumber: row.lineName,
          createdAt: row.createdAt.toISOString(),
          ringGroupId: -1,
          ringGroupName: "OpenPhone",
          team,
          source: "quo",
        });
      }
    }

    return res.json({ items, fetchedAt: 0 });
  } catch (err) {
    req.log.error(err, "vos missed-no-callback fallback error");
    return res.json({ items: missedNoCallbackCache, fetchedAt: callHistoryFetchedAt });
  }
});

router.get("/vos/missed-hourly", async (req, res) => {
  try {
    const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD in LA
    const teamLinesInList = sql.join(TEAM_QUO_LINES.map((l) => sql`${l}`), sql`, `);
    const rows = await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Los_Angeles'))::int AS hour,
        line_team,
        COUNT(*)::int AS cnt
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLinesInList})
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${todayLA}::date
      GROUP BY hour, line_team
      ORDER BY hour
    `);

    // Build hour map 0–23 with separate quo/pbx buckets per team
    type HourRow = { retention: { quo: number; pbx: number }; cs: { quo: number; pbx: number }; nsf: { quo: number; pbx: number } };
    const hourMap = new Map<number, HourRow>();
    const getHour = (h: number): HourRow => {
      if (!hourMap.has(h)) hourMap.set(h, {
        retention: { quo: 0, pbx: 0 },
        cs: { quo: 0, pbx: 0 },
        nsf: { quo: 0, pbx: 0 },
      });
      return hourMap.get(h)!;
    };

    // Populate Quo data from DB
    for (const r of rows.rows as { hour: number; line_team: string; cnt: number }[]) {
      const row = getHour(r.hour);
      if (r.line_team === "retention") row.retention.quo += r.cnt;
      else if (r.line_team === "cs") row.cs.quo += r.cnt;
      else if (r.line_team === "nsf") row.nsf.quo += r.cnt;
    }

    // Merge PBX hourly data from in-memory accumulator
    for (const [h, pbx] of Object.entries(cumulativeMissedByHour)) {
      const row = getHour(Number(h));
      row.retention.pbx += pbx.retention;
      row.cs.pbx += pbx.cs;
      row.nsf.pbx += pbx.nsf;
    }

    const hours = Array.from(hourMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([hour, teams]) => ({ hour, ...teams }));

    res.json({ hours });
  } catch (err) {
    req.log.error(err, "vos missed-hourly error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/vos/missed-daily", async (req, res) => {
  try {
    const window14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    // Quo: daily missed counts — shared team lines only
    const teamLinesInList = sql.join(TEAM_QUO_LINES.map((l) => sql`${l}`), sql`, `);
    const rows = await db.execute(sql`
      SELECT
        (created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
        line_team,
        COUNT(*)::int AS cnt
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLinesInList})
        AND created_at >= ${window14d}
      GROUP BY day, line_team
      ORDER BY day DESC, line_team
    `);

    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    // PBX historical: query persisted missed calls grouped by LA date + team
    const pbxRows = await db.execute(sql`
      SELECT
        (created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
        team,
        COUNT(*)::int AS cnt
      FROM pbx_missed_calls
      WHERE created_at >= ${window14d}
        AND team IN ('retention', 'cs', 'nsf')
      GROUP BY day, team
      ORDER BY day DESC, team
    `);

    // PBX today: supplement DB with the live in-memory cache (catches calls not yet persisted)
    const DAILY_PBX_RING_GROUPS: Record<string, "retention" | "cs" | "nsf"> = {
      "retention": "retention",
      "customer support": "cs",
      "nsf": "nsf",
    };
    const pbxTodayByTeam: Record<string, number> = {};
    for (const [rgId, count] of Object.entries(ringGroupMissedCache)) {
      const name = (ringGroupNameCache.get(Number(rgId)) ?? "").toLowerCase().trim();
      const team = DAILY_PBX_RING_GROUPS[name];
      if (team) pbxTodayByTeam[team] = (pbxTodayByTeam[team] ?? 0) + count;
    }

    // Merge Quo rows into a map keyed by date
    type TeamDay = { retention: { quo: number; pbx: number }; cs: { quo: number; pbx: number }; nsf: { quo: number; pbx: number } };
    const dayMap = new Map<string, TeamDay>();

    const getDay = (d: string): TeamDay => {
      if (!dayMap.has(d)) dayMap.set(d, {
        retention: { quo: 0, pbx: 0 },
        cs: { quo: 0, pbx: 0 },
        nsf: { quo: 0, pbx: 0 },
      });
      return dayMap.get(d)!;
    };

    for (const r of rows.rows as { day: unknown; line_team: string; cnt: number }[]) {
      const dateStr = r.day instanceof Date ? r.day.toISOString().split("T")[0] : String(r.day);
      const d = getDay(dateStr);
      const team = r.line_team as "retention" | "cs" | "nsf";
      if (team === "retention" || team === "cs" || team === "nsf") d[team].quo += r.cnt;
    }

    // Merge PBX historical rows from DB
    for (const r of pbxRows.rows as { day: unknown; team: string; cnt: number }[]) {
      const dateStr = r.day instanceof Date ? r.day.toISOString().split("T")[0] : String(r.day);
      const d = getDay(dateStr);
      const team = r.team as "retention" | "cs" | "nsf";
      if (team === "retention" || team === "cs" || team === "nsf") d[team].pbx += r.cnt;
    }

    // For today, use the max of DB count and live cache (live cache is more current)
    if (Object.keys(pbxTodayByTeam).length > 0) {
      const d = getDay(todayStr);
      for (const team of ["retention", "cs", "nsf"] as const) {
        const live = pbxTodayByTeam[team] ?? 0;
        if (live > d[team].pbx) d[team].pbx = live;
      }
    }

    const days = Array.from(dayMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, t]) => ({ date, ...t }));

    res.json({ days });
  } catch (err) {
    req.log.error(err, "vos missed-daily error");
    res.status(500).json({ error: String(err) });
  }
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
    const page = req.query["page"] ?? 1;
    const data = await vosFetch<{ calls: VosCallRaw[]; total: number }>(
      `/api/calls?limit=${limit}&page=${page}${agentId}`
    );
    res.json({ total: data.total, calls: data.calls });
  } catch (err) {
    req.log.error(err, "vos debug error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
