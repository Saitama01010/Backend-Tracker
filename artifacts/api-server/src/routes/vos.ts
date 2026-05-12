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
  internalNumbers: Set<string>,
  maxPages?: number
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

  const pagesToScan = maxPages ?? Math.max(10, Math.min(20, Math.ceil((totalCallsToday * 1.5) / 100) + 2));

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

// One-time deep backfill: on first server run, scan 100 pages to populate 14 days of PBX history.
let pbxBackfillDone = false;

// Cached set of our own phone numbers (PBX lines + OpenPhone lines), updated each refresh cycle.
// Used to exclude internal callers from the daily/hourly missed-call SQL queries.
let cachedInternalNumbers: string[] = [];

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
    cachedInternalNumbers = Array.from(internalNumbers).filter(Boolean);

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
      // Always queue for DB upsert — onConflictDoNothing handles dedup.
      toUpsert.push({
        id: rec.id,
        fromNumber: rec.fromNumber,
        toNumber: rec.toNumber,
        ringGroupId: rec.ringGroupId,
        ringGroupName: rec.ringGroupName,
        team: teamFromRingGroupName(rec.ringGroupName),
        createdAt: new Date(rec.createdAt),
      });
      // Only update the in-memory cumulative counter for calls not yet seen today.
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
      newCount++;
    }
    // Persist PBX missed calls so historical dates show correct PBX counts.
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

    // One-time startup deep backfill: scan 100 pages to populate 14+ days of PBX missed history.
    // Runs in background after the first successful refresh so ring group mappings are available.
    if (!pbxBackfillDone) {
      pbxBackfillDone = true;
      void (async () => {
        try {
          log?.info("vos: pbx backfill starting (100 pages)");
          const deep = await scanRingGroupCalls(
            lineToRingGroupId, ringGroupIdToName, dashboard.totalCallsToday ?? 600,
            agentToRingGroups, internalNumbers, 100
          );
          if (deep.missedRecords.length > 0) {
            const rows = deep.missedRecords.map((rec) => ({
              id: rec.id,
              fromNumber: rec.fromNumber,
              toNumber: rec.toNumber,
              ringGroupId: rec.ringGroupId,
              ringGroupName: rec.ringGroupName,
              team: teamFromRingGroupName(rec.ringGroupName),
              createdAt: new Date(rec.createdAt),
            }));
            await db.insert(pbxMissedCallsTable).values(rows).onConflictDoNothing();
          }
          log?.info({ scanned: deep.missedRecords.length }, "vos: pbx backfill complete");
        } catch (err) {
          log?.error(err, "vos: pbx backfill failed");
        }
      })();
    }
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
    const internalSet = new Set(cachedInternalNumbers);
    for (const row of quoMissed) {
      if (blocklist.has(row.participant)) continue;
      if (/[a-zA-Z]/.test(row.participant)) continue; // skip internal line-name participants
      if (internalSet.has(normalizePhone(row.participant))) continue; // skip internal numbers
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
    const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    // Accept optional ?date=YYYY-MM-DD; fall back to today.
    const dateParam = typeof req.query["date"] === "string" ? req.query["date"] : todayLA;
    const isToday = dateParam === todayLA;
    const mode = req.query["mode"] === "numbers" ? "numbers" : "times";

    const teamLinesInList = sql.join(TEAM_QUO_LINES.map((l) => sql`${l}`), sql`, `);
    const internalExclude = cachedInternalNumbers.length > 0
      ? sql`AND participant NOT IN (${sql.join(cachedInternalNumbers.map(n => sql`${n}`), sql`, `)})`
      : sql``;
    const quoCountExpr = mode === "numbers" ? sql`COUNT(DISTINCT participant)::int` : sql`COUNT(*)::int`;
    const rows = await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Los_Angeles'))::int AS hour,
        line_team,
        ${quoCountExpr} AS cnt
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLinesInList})
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${dateParam}::date
        AND participant ~ '^[^a-zA-Z]+$'
        ${internalExclude}
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

    if (isToday && mode === "times") {
      // Today + times: use fast in-memory accumulator
      for (const [h, pbx] of Object.entries(cumulativeMissedByHour)) {
        const row = getHour(Number(h));
        row.retention.pbx += pbx.retention;
        row.cs.pbx += pbx.cs;
        row.nsf.pbx += pbx.nsf;
      }
    } else {
      // Historical date OR numbers mode: query pbx_missed_calls table
      const pbxCountExpr = mode === "numbers" ? sql`COUNT(DISTINCT from_number)::int` : sql`COUNT(*)::int`;
      const pbxRows = await db.execute(sql`
        SELECT
          EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/Los_Angeles'))::int AS hour,
          team,
          ${pbxCountExpr} AS cnt
        FROM pbx_missed_calls
        WHERE (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${dateParam}::date
          AND team IN ('retention', 'cs', 'nsf')
        GROUP BY hour, team
        ORDER BY hour
      `);
      for (const r of pbxRows.rows as { hour: number; team: string; cnt: number }[]) {
        const row = getHour(r.hour);
        if (r.team === "retention") row.retention.pbx += r.cnt;
        else if (r.team === "cs") row.cs.pbx += r.cnt;
        else if (r.team === "nsf") row.nsf.pbx += r.cnt;
      }
    }

    const hours = Array.from(hourMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([hour, teams]) => ({ hour, ...teams }));

    res.json({ hours, date: dateParam });
  } catch (err) {
    req.log.error(err, "vos missed-hourly error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/vos/missed-daily", async (req, res) => {
  try {
    const window14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const mode = req.query["mode"] === "numbers" ? "numbers" : "times";

    // Quo: daily missed counts — shared team lines only, excluding internal callers
    const teamLinesInList = sql.join(TEAM_QUO_LINES.map((l) => sql`${l}`), sql`, `);
    const internalExclude = cachedInternalNumbers.length > 0
      ? sql`AND participant NOT IN (${sql.join(cachedInternalNumbers.map(n => sql`${n}`), sql`, `)})`
      : sql``;
    const quoCountExpr = mode === "numbers" ? sql`COUNT(DISTINCT participant)::int` : sql`COUNT(*)::int`;
    const rows = await db.execute(sql`
      SELECT
        (created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
        line_team,
        ${quoCountExpr} AS cnt
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLinesInList})
        AND created_at >= ${window14d}
        AND participant ~ '^[^a-zA-Z]+$'
        ${internalExclude}
      GROUP BY day, line_team
      ORDER BY day DESC, line_team
    `);

    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    // PBX: query persisted missed calls grouped by LA date + team
    const pbxCountExpr = mode === "numbers" ? sql`COUNT(DISTINCT from_number)::int` : sql`COUNT(*)::int`;
    const pbxRows = await db.execute(sql`
      SELECT
        (created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
        team,
        ${pbxCountExpr} AS cnt
      FROM pbx_missed_calls
      WHERE created_at >= ${window14d}
        AND team IN ('retention', 'cs', 'nsf')
      GROUP BY day, team
      ORDER BY day DESC, team
    `);

    // PBX today supplement: use live in-memory cache only in "times" mode
    // (in "numbers" mode the DB query above already covers today with DISTINCT)
    const pbxTodayByTeam: Record<string, number> = {};
    if (mode === "times") {
      for (const [rgId, count] of Object.entries(ringGroupMissedCache)) {
        const name = ringGroupNameCache.get(Number(rgId)) ?? "";
        const team = teamFromRingGroupName(name);
        if (team !== "other") pbxTodayByTeam[team] = (pbxTodayByTeam[team] ?? 0) + count;
      }
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

    // Merge PBX rows from DB
    for (const r of pbxRows.rows as { day: unknown; team: string; cnt: number }[]) {
      const dateStr = r.day instanceof Date ? r.day.toISOString().split("T")[0] : String(r.day);
      const d = getDay(dateStr);
      const team = r.team as "retention" | "cs" | "nsf";
      if (team === "retention" || team === "cs" || team === "nsf") d[team].pbx += r.cnt;
    }

    // For today in times mode, use the max of DB count and live cache (live is more current)
    if (mode === "times" && Object.keys(pbxTodayByTeam).length > 0) {
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

router.get("/vos/missed-breakdown", async (req, res) => {
  try {
    const dateParam = typeof req.query["date"] === "string" ? req.query["date"] : null;
    if (!dateParam) return res.status(400).json({ error: "date required (YYYY-MM-DD)" });

    const blocklist = await getBlockedNumbers();
    const teamLinesInList = sql.join(TEAM_QUO_LINES.map((l) => sql`${l}`), sql`, `);
    const internalExclude = cachedInternalNumbers.length > 0
      ? sql`AND participant NOT IN (${sql.join(cachedInternalNumbers.map(n => sql`${n}`), sql`, `)})`
      : sql``;

    const [quoRaw, pbxRaw] = await Promise.all([
      db.execute(sql`
        SELECT participant, line_team, created_at
        FROM phone_calls
        WHERE direction = 'incoming'
          AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
          AND line_name IN (${teamLinesInList})
          AND (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${dateParam}::date
          AND participant ~ '^[^a-zA-Z]+$'
          ${internalExclude}
        ORDER BY created_at ASC
      `),
      db.execute(sql`
        SELECT from_number, team, created_at
        FROM pbx_missed_calls
        WHERE (created_at AT TIME ZONE 'America/Los_Angeles')::date = ${dateParam}::date
          AND team IN ('retention', 'cs', 'nsf')
        ORDER BY created_at ASC
      `),
    ]);

    type QuoRow = { participant: string; line_team: string; created_at: Date };
    type PbxRow = { from_number: string; team: string; created_at: Date };

    // numMap keyed by normalized number; also track raw participant strings for SQL lookup
    type NumEntry = { fromNumber: string; team: string; sources: Set<"quo" | "pbx">; missedTimes: Date[]; rawParticipants: Set<string> };
    const numMap = new Map<string, NumEntry>();

    for (const r of quoRaw.rows as QuoRow[]) {
      if (blocklist.has(r.participant)) continue;
      const norm = normalizePhone(r.participant);
      if (!norm) continue;
      if (!numMap.has(norm)) numMap.set(norm, { fromNumber: r.participant, team: r.line_team, sources: new Set(), missedTimes: [], rawParticipants: new Set() });
      const e = numMap.get(norm)!;
      e.sources.add("quo");
      e.missedTimes.push(new Date(r.created_at));
      e.rawParticipants.add(r.participant);
    }
    for (const r of pbxRaw.rows as PbxRow[]) {
      if (blocklist.has(r.from_number)) continue;
      const norm = normalizePhone(r.from_number);
      if (!norm) continue;
      if (!numMap.has(norm)) numMap.set(norm, { fromNumber: r.from_number, team: r.team, sources: new Set(), missedTimes: [], rawParticipants: new Set() });
      const e = numMap.get(norm)!;
      e.sources.add("pbx");
      e.missedTimes.push(new Date(r.created_at));
      e.rawParticipants.add(r.from_number);
    }

    if (numMap.size === 0) return res.json({ date: dateParam, numbers: [], stats: { total: 0, withCallback: 0, rate: 0 } });

    // Use raw participant values (as stored in phone_calls) for the IN clause
    const allRaw = new Set<string>();
    for (const [, e] of numMap) for (const r of e.rawParticipants) allRaw.add(r);
    const rawList = sql.join(Array.from(allRaw).map(n => sql`${n}`), sql`, `);

    const outboundRaw = await db.execute(sql`
      SELECT participant, created_at
      FROM phone_calls
      WHERE direction = 'outgoing'
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date >= ${dateParam}::date
        AND (created_at AT TIME ZONE 'America/Los_Angeles')::date <= (${dateParam}::date + interval '1 day')
        AND participant IN (${rawList})
      ORDER BY created_at ASC
    `);

    // Normalize outbound results back to the same key as numMap
    const callbackMap = new Map<string, Date[]>();
    for (const r of outboundRaw.rows as { participant: string; created_at: Date }[]) {
      const norm = normalizePhone(r.participant);
      if (!norm) continue;
      if (!callbackMap.has(norm)) callbackMap.set(norm, []);
      callbackMap.get(norm)!.push(new Date(r.created_at));
    }

    type NumberBreakdown = {
      fromNumber: string; team: string; source: "quo" | "pbx" | "both";
      missedCount: number; firstMissedAt: string; hasCallback: boolean;
      callbackAt: string | null; responseMinutes: number | null;
    };
    const numbers: NumberBreakdown[] = [];

    for (const [norm, entry] of numMap) {
      entry.missedTimes.sort((a, b) => a.getTime() - b.getTime());
      const firstMissed = entry.missedTimes[0];
      const callbacks = callbackMap.get(norm);
      const callbackAt = callbacks?.find(t => t >= firstMissed) ?? null;
      const srcArr = Array.from(entry.sources);
      numbers.push({
        fromNumber: entry.fromNumber,
        team: entry.team,
        source: srcArr.length === 2 ? "both" : srcArr[0]!,
        missedCount: entry.missedTimes.length,
        firstMissedAt: firstMissed.toISOString(),
        hasCallback: !!callbackAt,
        callbackAt: callbackAt?.toISOString() ?? null,
        responseMinutes: callbackAt ? Math.round((callbackAt.getTime() - firstMissed.getTime()) / 60000) : null,
      });
    }

    // Not-called-back first, then by first missed time
    numbers.sort((a, b) => {
      if (a.hasCallback !== b.hasCallback) return a.hasCallback ? 1 : -1;
      return new Date(a.firstMissedAt).getTime() - new Date(b.firstMissedAt).getTime();
    });

    const withCallback = numbers.filter(n => n.hasCallback).length;
    res.json({ date: dateParam, numbers, stats: { total: numbers.length, withCallback, rate: Math.round(withCallback / numbers.length * 100) / 100 } });
  } catch (err) {
    req.log.error(err, "vos missed-breakdown error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/vos/callback-review", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query["days"] ?? 14), 1), 30);
    const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const blocklist = await getBlockedNumbers();

    const teamLinesInList = sql.join(TEAM_QUO_LINES.map((l) => sql`${l}`), sql`, `);
    const internalExclude = cachedInternalNumbers.length > 0
      ? sql`AND participant NOT IN (${sql.join(cachedInternalNumbers.map(n => sql`${n}`), sql`, `)})`
      : sql``;

    // All Quo missed calls in window (excluding internal/blocked)
    const quoMissedRaw = await db.execute(sql`
      SELECT id, participant, line_team, line_name, created_at
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLinesInList})
        AND created_at >= ${windowStart}
        AND participant ~ '^[^a-zA-Z]+$'
        ${internalExclude}
      ORDER BY created_at DESC
      LIMIT 2000
    `);

    // All PBX missed calls in window
    const pbxMissedRaw = await db.execute(sql`
      SELECT id, from_number, team, ring_group_name, created_at
      FROM pbx_missed_calls
      WHERE created_at >= ${windowStart}
        AND team IN ('retention', 'cs', 'nsf')
      ORDER BY created_at DESC
      LIMIT 2000
    `);

    type QuoRow = { id: string; participant: string; line_team: string; line_name: string; created_at: Date };
    type PbxRow = { id: number; from_number: string; team: string; ring_group_name: string; created_at: Date };

    const quoMissed = quoMissedRaw.rows as QuoRow[];
    const pbxMissed = pbxMissedRaw.rows as PbxRow[];

    // Collect unique normalized numbers (for callbackMap key) and raw values (for SQL IN clause)
    const allNumbers = new Set<string>();   // normalized — used as callbackMap key
    const allRawNumbers = new Set<string>(); // raw stored values — used in SQL IN clause
    for (const r of quoMissed) {
      if (!blocklist.has(r.participant)) {
        const n = normalizePhone(r.participant);
        if (n) { allNumbers.add(n); allRawNumbers.add(r.participant); }
      }
    }
    for (const r of pbxMissed) {
      if (!blocklist.has(r.from_number)) {
        const n = normalizePhone(r.from_number);
        if (n) { allNumbers.add(n); allRawNumbers.add(r.from_number); }
      }
    }

    // Build callback lookup from Quo outbound calls (query by raw participant values)
    const callbackMap = new Map<string, Date[]>();
    if (allRawNumbers.size > 0) {
      const rawList = sql.join(Array.from(allRawNumbers).map(n => sql`${n}`), sql`, `);
      const outboundRaw = await db.execute(sql`
        SELECT participant, created_at
        FROM phone_calls
        WHERE direction = 'outgoing'
          AND created_at >= ${windowStart}
          AND participant IN (${rawList})
        ORDER BY created_at ASC
      `);
      // Normalize outbound results to match allNumbers keys
      for (const r of outboundRaw.rows as { participant: string; created_at: Date }[]) {
        const norm = normalizePhone(r.participant);
        if (!norm) continue;
        if (!callbackMap.has(norm)) callbackMap.set(norm, []);
        callbackMap.get(norm)!.push(new Date(r.created_at));
      }
    }

    type ReviewItem = {
      id: string; fromNumber: string; team: string; source: "quo" | "pbx";
      ringGroupName: string; missedAt: string; hasCallback: boolean;
      callbackAt: string | null; responseMinutes: number | null;
    };
    const items: ReviewItem[] = [];

    for (const r of quoMissed) {
      if (blocklist.has(r.participant)) continue;
      const norm = normalizePhone(r.participant);
      if (!norm) continue;
      const missedAt = new Date(r.created_at);
      const callbacks = callbackMap.get(norm);
      const callbackAt = callbacks?.find(t => t >= missedAt) ?? null;
      items.push({
        id: `quo-${r.id}`,
        fromNumber: r.participant,
        team: r.line_team,
        source: "quo",
        ringGroupName: r.line_name,
        missedAt: missedAt.toISOString(),
        hasCallback: !!callbackAt,
        callbackAt: callbackAt?.toISOString() ?? null,
        responseMinutes: callbackAt ? Math.round((callbackAt.getTime() - missedAt.getTime()) / 60000) : null,
      });
    }

    for (const r of pbxMissed) {
      if (blocklist.has(r.from_number)) continue;
      const norm = normalizePhone(r.from_number);
      if (!norm) continue;
      const missedAt = new Date(r.created_at);
      const callbacks = callbackMap.get(norm);
      const callbackAt = callbacks?.find(t => t >= missedAt) ?? null;
      items.push({
        id: `pbx-${r.id}`,
        fromNumber: r.from_number,
        team: r.team,
        source: "pbx",
        ringGroupName: r.ring_group_name,
        missedAt: missedAt.toISOString(),
        hasCallback: !!callbackAt,
        callbackAt: callbackAt?.toISOString() ?? null,
        responseMinutes: callbackAt ? Math.round((callbackAt.getTime() - missedAt.getTime()) / 60000) : null,
      });
    }

    items.sort((a, b) => new Date(b.missedAt).getTime() - new Date(a.missedAt).getTime());

    const withCallback = items.filter(i => i.hasCallback).length;
    const rate = items.length > 0 ? withCallback / items.length : 0;
    const responseTimes = items.filter(i => i.responseMinutes !== null).map(i => i.responseMinutes!);
    const avgResponseMinutes = responseTimes.length > 0
      ? Math.round(responseTimes.reduce((s, m) => s + m, 0) / responseTimes.length)
      : 0;

    res.json({ items, stats: { total: items.length, withCallback, rate: Math.round(rate * 100) / 100, avgResponseMinutes, days } });
  } catch (err) {
    req.log.error(err, "vos callback-review error");
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
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const data = await vosFetch<{ calls: VosCallRaw[]; total: number }>(
      `/api/calls${qs ? `?${qs}` : ""}`
    );
    res.json({ total: data.total, calls: data.calls });
  } catch (err) {
    req.log.error(err, "vos debug error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/vos/debug/proxy", async (req, res) => {
  try {
    const path = String(req.query["path"] ?? "/api/calls?limit=1");
    const data = await vosFetch<unknown>(path);
    res.json(data);
  } catch (err) {
    req.log.error(err, "vos debug proxy error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
