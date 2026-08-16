import { Router } from "express";
import { db, phoneCallsTable, pbxMissedCallsTable } from "@workspace/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { getBlockedNumbers } from "../lib/blockedNumbers.js";
import { getActiveReadymodeItems } from "./nsfReadymode.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  approvedVosDebugPath,
  parseBoundedInteger,
  validateIntegrationDateRange,
} from "../lib/externalIntegrationPolicy.js";
import { postgresBackgroundJobStore } from "../lib/backgroundJobStore.js";
import { manualJobKey, scheduledJobKey } from "../lib/durableBackgroundJobs.js";
import { getDurableRuntimeState, putDurableRuntimeState } from "../lib/durableRuntimeState.js";
import { OPERATIONAL_CONFIG } from "../lib/operationalConfig.js";
import { businessDayWindow, formatCalendarDate } from "../lib/businessTime.js";
import type { AuthPayload } from "../middleware/authCore.js";
import { scopeMissedItemsForUser } from "../lib/missedCallScope.js";
import { canAccessFullTeam, isAdministrator, type MetricTeam } from "../middleware/authorizationCore.js";
import {
  fetchPbxJson,
  type VosAgent,
  type VosCallRaw,
  type VosDashboard,
  type VosRingGroup,
} from "../integrations/pbx/client.js";
import { teamFromRingGroupName } from "../integrations/pbx/mapper.js";
import { fetchQuoDirectoryPhoneNumbers } from "../integrations/quo/client.js";
import { retentionPbxService } from "../modules/retention/retention.pbx.service.js";
import type {
  RetentionPbxCallHistoryStat,
  RetentionPbxRingGroupMissed,
} from "../modules/retention/retention.pbx.types.js";
import { parsePbxBreakdownQuery, parsePbxDailyQuery, parsePbxHourlyQuery } from "../modules/pbx/pbx.schemas.js";
import { pbxMissedReportingService } from "../modules/pbx/pbx.missed.service.js";
import {
  KNOWN_GHOST_NUMBERS,
  normalizeCustomerPhone,
  normalizePhone,
  phoneComparisonKeys,
} from "../modules/pbx/pbx.phone.js";

const router = Router();
router.use("/vos", requireAuth);

// ─── Session ─────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Per-agent completed-call spans from the most recent VoSLogic refresh.
 * Keyed by lowercase agent name. Consumed by violations.ts for busy detection.
 */
export const vosCallSpansCache = new Map<string, Array<{ start: number; end: number }>>();
export const vosCallTimestampsCache = new Map<string, Array<{ at: string; source: "pbx"; id: string }>>();

export type VosCallHistoryStat = RetentionPbxCallHistoryStat;
export type VosRingGroupMissed = RetentionPbxRingGroupMissed;

export interface MissedNoCallbackItem {
  id: string | number;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "retention" | "nsf" | "cs" | "other";
  source: "pbx" | "quo" | "readymode";
  missedCallId?: string | number | null;
  normalizedCustomerNumber?: string;
  lineId?: string | null;
  callbackFound?: boolean;
  callbackId?: string | null;
  debugReason?: string;
}

function scopeMissedItems(req: { user?: AuthPayload }, items: MissedNoCallbackItem[]): MissedNoCallbackItem[] {
  return scopeMissedItemsForUser(req.user, items);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type CallbackEntry = { at: Date; id: string | null; source: "pbx" | "quo-outbound" | "quo-inbound" };

function addCallback(
  map: Map<string, CallbackEntry[]>,
  rawPhone: string,
  at: Date,
  id: string | null,
  source: CallbackEntry["source"],
) {
  for (const key of phoneComparisonKeys(rawPhone)) {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({ at, id, source });
  }
}

function findLaterCallback(
  map: Map<string, CallbackEntry[]>,
  rawPhone: string,
  missedAt: Date,
): CallbackEntry | null {
  const matches: CallbackEntry[] = [];
  for (const key of phoneComparisonKeys(rawPhone)) {
    for (const entry of map.get(key) ?? []) {
      if (entry.at > missedAt) matches.push(entry);
    }
  }
  matches.sort((a, b) => a.at.getTime() - b.at.getTime());
  return matches[0] ?? null;
}

type PbxMissedRecord = {
  id: number;
  fromNumber: string;
  toNumber: string;
  createdAt: string | Date;
  ringGroupId: number;
  ringGroupName: string;
  team?: string | null;
};

function pbxTeamFromMissedRecord(rec: PbxMissedRecord): MissedNoCallbackItem["team"] {
  const team = rec.team;
  if (team === "retention" || team === "nsf" || team === "cs") return team;
  return teamFromRingGroupName(rec.ringGroupName);
}

function buildPbxMissedNoCallbackItems(
  rows: PbxMissedRecord[],
  callbacks: Map<string, CallbackEntry[]>,
  blocklist: Set<string>,
  internalNumbers: Set<string>,
): MissedNoCallbackItem[] {
  const out: MissedNoCallbackItem[] = [];
  const seen = new Set<string>();

  for (const rec of rows) {
    const normalizedCustomerNumber = normalizeCustomerPhone(rec.fromNumber);
    const last10 = normalizePhone(rec.fromNumber);
    if (!normalizedCustomerNumber || !last10) continue;
    if (blocklist.has(rec.fromNumber) || blocklist.has(last10) || blocklist.has(normalizedCustomerNumber)) continue;
    if (internalNumbers.has(last10) || internalNumbers.has(normalizedCustomerNumber)) continue;

    const missedAt = new Date(rec.createdAt);
    if (Number.isNaN(missedAt.getTime())) continue;
    const dedupeKey = Number.isFinite(rec.id)
      ? `pbx:${rec.id}`
      : `pbx:${normalizedCustomerNumber}:${rec.ringGroupId}:${missedAt.toISOString()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const callback = findLaterCallback(callbacks, rec.fromNumber, missedAt);
    if (callback) continue;

    out.push({
      id: String(rec.id),
      fromNumber: rec.fromNumber,
      toNumber: rec.toNumber,
      createdAt: missedAt.toISOString(),
      ringGroupId: rec.ringGroupId,
      ringGroupName: rec.ringGroupName,
      team: pbxTeamFromMissedRecord(rec),
      source: "pbx",
      missedCallId: rec.id,
      normalizedCustomerNumber,
      callbackFound: false,
      callbackId: null,
      debugReason: "PBX missed call with no later PBX, Quo/OpenPhone, or available outbound callback found for this normalized customer number.",
    });
  }

  return out;
}

// Ring groups whose missed calls should never appear in the missed-no-callback panel.
const EXCLUDED_RING_GROUPS = new Set(["MX Retention"]);

// Numbers confirmed as ghost callers — always flagged regardless of call metadata.
// Stored as last-10-digits (matches normalizePhone output).
// ─── Fetch our own OpenPhone line numbers ─────────────────────────────────────

async function fetchQuoLineNumbers(): Promise<Set<string>> {
  const nums = new Set<string>();
  for (const number of await fetchQuoDirectoryPhoneNumbers()) nums.add(normalizePhone(number));
  return nums;
}

// Only these Quo/OpenPhone line names are team-shared lines.
// Personal agent lines (e.g. "Rick Miller RT OB", "Jenny NSF") are excluded.
const TEAM_QUO_LINES = [...OPERATIONAL_CONFIG.trackedTeamLines];

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
  callSpans: Array<{ start: number; end: number }>;
  callTimestamps: Array<{ at: string; source: "pbx"; id: string }>;
}> {
  let answered = 0, missed = 0, voicemail = 0, durationSeconds = 0;
  const callSpans: Array<{ start: number; end: number }> = [];
  let lastCallAt: string | null = null;
  let firstCallAt: string | null = null;
  const inboundToNumbers: string[] = [];
  const outboundCallbacks: Array<{ toNumber: string; createdAt: string }> = [];
  const inboundAnsweredFrom: Array<{ fromNumber: string; createdAt: string }> = [];
  const callTimestamps: Array<{ at: string; source: "pbx"; id: string }> = [];
  let totalSeen = 0;
  const cap = expectedCount;
  let page = 1;

  while (page <= 20) {
    const data = await fetchPbxJson<{ calls: VosCallRaw[] }>(
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
      callTimestamps.push({ at: call.createdAt, source: "pbx", id: `pbx:${call.id}` });

      // Track call span for busy detection (used by violations.ts).
      // In-progress calls use a 3-hour fallback so they register as busy.
      // Matches violations.ts INPROGRESS_FALLBACK_S — see the comment there
      // (warm-transfer/coaching call legs can stay "in-progress" in upstream
      // dialer APIs long after they actually end).
      const INPROGRESS_FALLBACK_VOS = 3 * 3600;
      const spanDur = (call.duration && call.duration > 0)
        ? call.duration
        : (call.status === "in-progress" ? INPROGRESS_FALLBACK_VOS : 0);
      if (spanDur > 0) {
        const s = new Date(call.createdAt).getTime();
        callSpans.push({ start: s, end: s + spanDur * 1000 });
      }

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

  return { answered, missed, voicemail, durationSeconds, lastCallAt, firstCallAt, inboundToNumbers, outboundCallbacks, inboundAnsweredFrom, callSpans, callTimestamps };
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
    const data = await fetchPbxJson<{ calls: VosCallRaw[] }>(
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

// Cached set of our own phone numbers (PBX lines + OpenPhone lines), updated each refresh cycle.
// Used to exclude internal callers from the daily/hourly missed-call SQL queries.
let cachedInternalNumbers: string[] = [];

interface VosDurableSnapshot extends Record<string, unknown> {
  callHistory: VosCallHistoryStat[];
  fetchedAt: number;
  ringGroupMissed: VosRingGroupMissed;
  missedNoCallback: MissedNoCallbackItem[];
  ringGroupNames: Array<[number, string]>;
  internalNumbers: string[];
  lineRingGroups: Array<[string, number]>;
  seenMissedCallIds: number[];
  cumulativeDate: string;
  cumulativeMissedByHour: Record<number, { retention: number; cs: number; nsf: number }>;
  callSpans: Array<[string, Array<{ start: number; end: number }>]>;
  callTimestamps: Array<[string, Array<{ at: string; source: "pbx"; id: string }>]>;
}

export async function hydrateVosState(): Promise<void> {
  const snapshot = await getDurableRuntimeState<VosDurableSnapshot>("vos:call-history");
  if (!snapshot || snapshot.value.fetchedAt <= callHistoryFetchedAt) return;
  const value = snapshot.value;
  callHistoryCache = value.callHistory ?? [];
  callHistoryFetchedAt = value.fetchedAt;
  ringGroupMissedCache = value.ringGroupMissed ?? {};
  for (const key of Object.keys(cumulativeRingGroupMissed)) delete cumulativeRingGroupMissed[Number(key)];
  Object.assign(cumulativeRingGroupMissed, value.ringGroupMissed ?? {});
  missedNoCallbackCache = value.missedNoCallback ?? [];
  ringGroupNameCache = new Map(value.ringGroupNames ?? []);
  cachedInternalNumbers = value.internalNumbers ?? [];
  persistentLineRgMap.clear();
  for (const [line, group] of value.lineRingGroups ?? []) persistentLineRgMap.set(line, group);
  seenMissedCallIds.clear();
  for (const id of value.seenMissedCallIds ?? []) seenMissedCallIds.add(id);
  cumulativeDate = value.cumulativeDate ?? "";
  for (const key of Object.keys(cumulativeMissedByHour)) delete cumulativeMissedByHour[Number(key)];
  Object.assign(cumulativeMissedByHour, value.cumulativeMissedByHour ?? {});
  vosCallSpansCache.clear();
  for (const [agent, spans] of value.callSpans ?? []) vosCallSpansCache.set(agent, spans);
  vosCallTimestampsCache.clear();
  for (const [agent, calls] of value.callTimestamps ?? []) vosCallTimestampsCache.set(agent, calls);
}

export async function refreshCallHistory(
  log?: Logger,
  options: { deepBackfill?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (callHistoryFetching) return;
  callHistoryFetching = true;
  // Clear the span cache before rebuilding so stale entries from previous day don't persist.
  vosCallSpansCache.clear();
  vosCallTimestampsCache.clear();
  const t0 = Date.now();
  try {
    options.signal?.throwIfAborted();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const [dashboard, agentList, ringGroups] = await Promise.all([
      fetchPbxJson<VosDashboard>("/api/dashboard"),
      fetchPbxJson<VosAgent[]>("/api/agents"),
      fetchPbxJson<VosRingGroup[]>("/api/ring-groups"),
    ]);
    options.signal?.throwIfAborted();

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
      options.signal?.throwIfAborted();
      const batch = agents.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (a) => {
          options.signal?.throwIfAborted();
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
              inboundAnsweredFrom: [] as Array<{ fromNumber: string; createdAt: string }>,
              callSpans: [] as Array<{ start: number; end: number }>,
              callTimestamps: [] as Array<{ at: string; source: "pbx"; id: string }>,
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
            callSpans: detail.callSpans,
            callTimestamps: detail.callTimestamps,
          };
        })
      );
      for (const r of batchResults) {
        const { inboundToNumbers: _, outboundCallbacks: __, inboundAnsweredFrom: _ia, callSpans: _cs, callTimestamps: _ct, ...stat } = r;
        results.push(stat satisfies VosCallHistoryStat);
        // Feed every per-agent outbound call into the callback map immediately
        // so it's available for cross-referencing after all agents are scanned.
        for (const cb of __) agentOutboundCallbacks.push(cb);
        // Inbound answered calls also resolve a missed call (customer called back in).
        for (const ia of _ia) agentInboundAnswered.push(ia);
        // Populate busy-detection span cache used by violations.ts
        if (_cs && _cs.length > 0) {
          const key = r.agentName.toLowerCase();
          const existing = vosCallSpansCache.get(key) ?? [];
          for (const sp of _cs) existing.push(sp);
          vosCallSpansCache.set(key, existing);
        }
        if (_ct && _ct.length > 0) {
          const key = r.agentName.toLowerCase();
          const existing = vosCallTimestampsCache.get(key) ?? [];
          for (const t of _ct) existing.push(t);
          vosCallTimestampsCache.set(key, existing);
        }
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
          const data = await fetchPbxJson<{ calls: VosCallRaw[] }>(
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
    options.signal?.throwIfAborted();

    // Build a set of all our own internal numbers (PBX lines + OpenPhone lines).
    // Any missed call FROM one of these numbers is an internal call and should be excluded.
    const quoLineNumbers = await fetchQuoLineNumbers();
    const internalNumbers = new Set<string>([
      ...[...lineToRingGroupId.keys()].map(normalizePhone),
      ...quoLineNumbers,
    ]);
    cachedInternalNumbers = Array.from(internalNumbers).filter(Boolean);

    const scanResult = await scanRingGroupCalls(lineToRingGroupId, ringGroupIdToName, dashboard.totalCallsToday ?? 600, agentToRingGroups, internalNumbers);
    options.signal?.throwIfAborted();

    // ── Cross-reference missed records against callbacks ──────────────────────
    // Build callback lookup: normalized phone → all times an outbound call was made today
    const callbackTimes = new Map<string, CallbackEntry[]>();

    // Per-agent outbound calls — most complete PBX source (full per-agent history scanned above)
    for (const c of agentOutboundCallbacks) {
      addCallback(callbackTimes, c.toNumber, new Date(c.createdAt), null, "pbx");
    }

    // Per-agent inbound answered calls — customer called back in and was handled.
    // fromNumber is the customer's number, so it resolves the missed call for that number.
    for (const c of agentInboundAnswered) {
      addCallback(callbackTimes, c.fromNumber, new Date(c.createdAt), null, "pbx");
    }

    // Global scan outbound calls — supplementary, catches any agents not in dashboard.callsByAgent
    for (const c of scanResult.pbxOutboundCalls) {
      addCallback(callbackTimes, c.toNumber, new Date(c.createdAt), null, "pbx");
    }

    // Quo DB outbound calls — use a 36-hour window to cover any timezone offset between
    // the server (UTC) and the business's local time, ensuring no callbacks are missed.
    const window36h = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const [quoOutbound, quoInboundAnswered, persistedPbxMissed] = await Promise.all([
      db
        .select({ id: phoneCallsTable.id, participant: phoneCallsTable.participant, createdAt: phoneCallsTable.createdAt })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "outgoing"), gte(phoneCallsTable.createdAt, window36h))),
      // Inbound answered Quo calls: customer called us on OpenPhone and was handled.
      db
        .select({ id: phoneCallsTable.id, participant: phoneCallsTable.participant, createdAt: phoneCallsTable.createdAt })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "incoming"), eq(phoneCallsTable.status, "completed"), gte(phoneCallsTable.createdAt, window36h))),
      db
        .select({
          id: pbxMissedCallsTable.id,
          fromNumber: pbxMissedCallsTable.fromNumber,
          toNumber: pbxMissedCallsTable.toNumber,
          createdAt: pbxMissedCallsTable.createdAt,
          ringGroupId: pbxMissedCallsTable.ringGroupId,
          ringGroupName: pbxMissedCallsTable.ringGroupName,
          team: pbxMissedCallsTable.team,
        })
        .from(pbxMissedCallsTable)
        .where(gte(pbxMissedCallsTable.createdAt, window36h)),
    ]);

    for (const row of quoOutbound) {
      addCallback(callbackTimes, row.participant, new Date(row.createdAt), row.id, "quo-outbound");
    }
    for (const row of quoInboundAnswered) {
      addCallback(callbackTimes, row.participant, new Date(row.createdAt), row.id, "quo-inbound");
    }

    const blocklist = await getBlockedNumbers();

    // Determine which PBX missed calls had no callback after the missed call time.
    // Use both the current scan and persisted PBX missed rows so the page does not
    // drop older same-day PBX misses once they fall out of VoSLogic's recent pages.
    const missedNoCB: MissedNoCallbackItem[] = [];
    missedNoCB.push(
      ...buildPbxMissedNoCallbackItems(
        [...scanResult.missedRecords, ...persistedPbxMissed],
        callbackTimes,
        blocklist,
        internalNumbers,
      ),
    );

    // Quo (OpenPhone) missed calls — reuse the same callbackTimes map already built above
    const quoMissed = await db
      .select({
        id: phoneCallsTable.id,
        participant: phoneCallsTable.participant,
        lineId: phoneCallsTable.lineId,
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        ringDurationSeconds: phoneCallsTable.ringDurationSeconds,
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

    const seenQuoMissed = new Set<string>();
    for (const row of quoMissed) {
      const normalizedCustomerNumber = normalizeCustomerPhone(row.participant);
      const last10 = normalizePhone(row.participant);
      if (!normalizedCustomerNumber || !last10) continue;
      if (blocklist.has(row.participant) || blocklist.has(last10) || blocklist.has(normalizedCustomerNumber)) continue;
      if (/[a-zA-Z]/.test(row.participant)) continue; // skip internal line-name participants
      if (internalNumbers.has(last10) || internalNumbers.has(normalizedCustomerNumber)) continue; // skip our own line numbers
      // Ghost call: rang for ≤2 seconds. Use ring_duration_seconds when available, fall back to duration_seconds=0.
      const ringDur = row.ringDurationSeconds ?? ((row.durationSeconds ?? 0) === 0 ? 0 : 999);
      if (ringDur <= 2) continue;
      const missedAt = new Date(row.createdAt);
      const callback = findLaterCallback(callbackTimes, row.participant, missedAt);
      if (!callback) {
        const dedupeKey = `${normalizedCustomerNumber}:${row.lineId}:${Math.floor(missedAt.getTime() / 60000)}`;
        if (seenQuoMissed.has(dedupeKey)) continue;
        seenQuoMissed.add(dedupeKey);
        const t = row.lineTeam;
        const team: MissedNoCallbackItem["team"] =
          t === "retention" || t === "nsf" || t === "cs" ? t : "other";
        missedNoCB.push({
          id: `quo-${row.id}`,
          missedCallId: row.id,
          fromNumber: row.participant,
          toNumber: row.lineName,
          createdAt: row.createdAt.toISOString(),
          ringGroupId: -1,
          ringGroupName: "OpenPhone",
          team,
          source: "quo",
          normalizedCustomerNumber,
          lineId: row.lineId,
          callbackFound: false,
          callbackId: null,
          debugReason: "Inbound Quo call was not answered and no later callback/outbound attempt was found for this normalized customer number.",
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
      options.signal?.throwIfAborted();
      await db.insert(pbxMissedCallsTable)
        .values(toUpsert)
        .onConflictDoNothing();
    }

    // Merge NSF Readymode queue items (manual entries from Samia).
    try {
      const rm = await getActiveReadymodeItems();
      for (const it of rm) missedNoCB.push(it);
    } catch (e) {
      log?.warn({ err: e }, "readymode queue merge failed");
    }

    callHistoryCache = results;
    callHistoryFetchedAt = Date.now();
    ringGroupMissedCache = { ...cumulativeRingGroupMissed };
    missedNoCallbackCache = missedNoCB;
    options.signal?.throwIfAborted();
    await putDurableRuntimeState("vos:call-history", {
      callHistory: callHistoryCache,
      fetchedAt: callHistoryFetchedAt,
      ringGroupMissed: ringGroupMissedCache,
      missedNoCallback: missedNoCallbackCache,
      ringGroupNames: [...ringGroupNameCache.entries()],
      internalNumbers: cachedInternalNumbers,
      lineRingGroups: [...persistentLineRgMap.entries()],
      seenMissedCallIds: [...seenMissedCallIds],
      cumulativeDate,
      cumulativeMissedByHour,
      callSpans: [...vosCallSpansCache.entries()],
      callTimestamps: [...vosCallTimestampsCache.entries()],
    } satisfies VosDurableSnapshot, 24 * 60 * 60_000);

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

    if (options.deepBackfill) {
      options.signal?.throwIfAborted();
      log?.info("vos: durable PBX backfill starting (100 pages)");
      const deep = await scanRingGroupCalls(
        lineToRingGroupId, ringGroupIdToName, dashboard.totalCallsToday ?? 600,
        agentToRingGroups, internalNumbers, 100,
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
      log?.info({ scanned: deep.missedRecords.length }, "vos: durable PBX backfill complete");
    }
  } catch (err) {
    log?.error(err, "vos: call history refresh failed");
    throw err;
  } finally {
    callHistoryFetching = false;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post("/vos/refresh", requireRole("admin"), async (req, res) => {
  try {
    await postgresBackgroundJobStore.enqueue({
      jobType: "integration_live_refresh",
      idempotencyKey: manualJobKey("integration_live_refresh", req.user!.userId, new Date(), 5_000),
      requestedByUserId: req.user!.userId,
      priority: 100,
      maxAttempts: 4,
    });
    res.json({ ok: true });
  } catch (error) {
    req.log.error(error, "PBX refresh enqueue failed");
    res.status(503).json({ error: "PBX refresh could not be queued" });
  }
});

router.get("/vos/stats", async (req, res) => {
  try {
    await hydrateVosState();
    const payload = await retentionPbxService.getStats({
      actor: req.user!,
      cache: {
        callHistory: callHistoryCache,
        fetchedAt: callHistoryFetchedAt,
        ringGroupMissed: ringGroupMissedCache,
      },
      log: req.log,
    });
    res.json(payload);
  } catch (err) {
    req.log.error(err, "vos stats error");
    res.status(500).json({ error: "PBX statistics are temporarily unavailable." });
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
  await hydrateVosState();
  const cacheAgeMs = callHistoryFetchedAt ? Date.now() - callHistoryFetchedAt : Infinity;
  if (cacheAgeMs > 30 * 1000) {
    const minute = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "");
    await postgresBackgroundJobStore.enqueue({
      jobType: "integration_live_refresh",
      idempotencyKey: scheduledJobKey("integration_live_refresh", minute),
      priority: 100,
      maxAttempts: 4,
    }).catch((error) => req.log.warn(error, "PBX refresh enqueue failed"));
  }
  // Fast path: full cache is ready. Merge Readymode queue live so newly added
  // items appear immediately (cache only refreshes every ~15 min).
  if (callHistoryFetchedAt > 0) {
    let extra: MissedNoCallbackItem[] = [];
    try { extra = await getActiveReadymodeItems(); } catch { /* best-effort */ }
    // Strip readymode items from the cache so Done clicks take effect immediately
    // instead of waiting for the 15-min cache refresh. Then append fresh active
    // readymode items (which already excludes anything marked done).
    const cacheWithoutReadymode = missedNoCallbackCache.filter(
      (i) => i.source !== "readymode",
    );
    const merged = [...cacheWithoutReadymode, ...extra];
    return res.json({ items: scopeMissedItems(req, merged), fetchedAt: callHistoryFetchedAt });
  }
  // PBX scan still in progress — serve Quo DB-only results so the page isn't empty
  try {
    const now = new Date();
    const todayWindow = businessDayWindow(formatCalendarDate(now));
    const windowStart = req.user!.lockToToday && !isAdministrator(req.user!)
      ? todayWindow.start
      : new Date(now.getTime() - 36 * 60 * 60 * 1000);
    const phoneDateConditions = req.user!.lockToToday && !isAdministrator(req.user!)
      ? [gte(phoneCallsTable.createdAt, windowStart), lt(phoneCallsTable.createdAt, todayWindow.endExclusive)]
      : [gte(phoneCallsTable.createdAt, windowStart)];
    const pbxDateConditions = req.user!.lockToToday && !isAdministrator(req.user!)
      ? [gte(pbxMissedCallsTable.createdAt, windowStart), lt(pbxMissedCallsTable.createdAt, todayWindow.endExclusive)]
      : [gte(pbxMissedCallsTable.createdAt, windowStart)];
    const [quoMissed, quoOutbound, quoInboundAnswered, persistedPbxMissed] = await Promise.all([
      db
        .select({
          id: phoneCallsTable.id,
          participant: phoneCallsTable.participant,
          lineId: phoneCallsTable.lineId,
          lineTeam: phoneCallsTable.lineTeam,
          lineName: phoneCallsTable.lineName,
          status: phoneCallsTable.status,
          durationSeconds: phoneCallsTable.durationSeconds,
          ringDurationSeconds: phoneCallsTable.ringDurationSeconds,
          createdAt: phoneCallsTable.createdAt,
        })
        .from(phoneCallsTable)
        .where(
          and(
            eq(phoneCallsTable.direction, "incoming"),
            inArray(phoneCallsTable.status, ["no-answer", "voicemail", "missed", "voicemail-brief"]),
            ...phoneDateConditions,
            inArray(phoneCallsTable.lineName, TEAM_QUO_LINES)
          )
        ),
      db
        .select({ id: phoneCallsTable.id, participant: phoneCallsTable.participant, createdAt: phoneCallsTable.createdAt })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "outgoing"), ...phoneDateConditions)),
      db
        .select({ id: phoneCallsTable.id, participant: phoneCallsTable.participant, createdAt: phoneCallsTable.createdAt })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "incoming"), eq(phoneCallsTable.status, "completed"), ...phoneDateConditions)),
      db
        .select({
          id: pbxMissedCallsTable.id,
          fromNumber: pbxMissedCallsTable.fromNumber,
          toNumber: pbxMissedCallsTable.toNumber,
          createdAt: pbxMissedCallsTable.createdAt,
          ringGroupId: pbxMissedCallsTable.ringGroupId,
          ringGroupName: pbxMissedCallsTable.ringGroupName,
          team: pbxMissedCallsTable.team,
        })
        .from(pbxMissedCallsTable)
        .where(and(...pbxDateConditions)),
    ]);

    const callbackTimes = new Map<string, CallbackEntry[]>();
    for (const row of quoOutbound) {
      addCallback(callbackTimes, row.participant, new Date(row.createdAt), row.id, "quo-outbound");
    }
    for (const row of quoInboundAnswered) {
      addCallback(callbackTimes, row.participant, new Date(row.createdAt), row.id, "quo-inbound");
    }

    const blocklist = await getBlockedNumbers();
    const items: MissedNoCallbackItem[] = [];
    const internalSet = new Set(cachedInternalNumbers);
    items.push(...buildPbxMissedNoCallbackItems(persistedPbxMissed, callbackTimes, blocklist, internalSet));
    const seenQuoMissed = new Set<string>();
    for (const row of quoMissed) {
      const normalizedCustomerNumber = normalizeCustomerPhone(row.participant);
      const last10 = normalizePhone(row.participant);
      if (!normalizedCustomerNumber || !last10) continue;
      if (blocklist.has(row.participant) || blocklist.has(last10) || blocklist.has(normalizedCustomerNumber)) continue;
      if (/[a-zA-Z]/.test(row.participant)) continue; // skip internal line-name participants
      if (internalSet.has(last10) || internalSet.has(normalizedCustomerNumber)) continue; // skip internal numbers
      // Ghost call: rang for ≤2 seconds. Use ring_duration_seconds when available, fall back to duration_seconds=0.
      const ringDur = row.ringDurationSeconds ?? ((row.durationSeconds ?? 0) === 0 ? 0 : 999);
      if (ringDur <= 2) continue;
      const missedAt = new Date(row.createdAt);
      const callback = findLaterCallback(callbackTimes, row.participant, missedAt);
      if (!callback) {
        const dedupeKey = `${normalizedCustomerNumber}:${row.lineId}:${Math.floor(missedAt.getTime() / 60000)}`;
        if (seenQuoMissed.has(dedupeKey)) continue;
        seenQuoMissed.add(dedupeKey);
        const t = row.lineTeam;
        const team: MissedNoCallbackItem["team"] =
          t === "retention" || t === "nsf" || t === "cs" ? t : "other";
        items.push({
          id: `quo-${row.id}`,
          missedCallId: row.id,
          fromNumber: row.participant,
          toNumber: row.lineName,
          createdAt: row.createdAt.toISOString(),
          ringGroupId: -1,
          ringGroupName: "OpenPhone",
          team,
          source: "quo",
          normalizedCustomerNumber,
          lineId: row.lineId,
          callbackFound: false,
          callbackId: null,
          debugReason: "Inbound Quo call was not answered and no later callback/outbound attempt was found for this normalized customer number.",
        });
      }
    }

    try {
      const rm = await getActiveReadymodeItems();
      for (const it of rm) items.push(it);
    } catch (e) {
      req.log.warn({ err: e }, "readymode queue merge failed (fallback)");
    }

    return res.json({ items: scopeMissedItems(req, items), fetchedAt: 0 });
  } catch (err) {
    req.log.error(err, "vos missed-no-callback fallback error");
    return res.json({ items: scopeMissedItems(req, missedNoCallbackCache), fetchedAt: callHistoryFetchedAt });
  }
});

router.get("/vos/missed-hourly", async (req, res) => {
  try {
    const parsed = parsePbxHourlyQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(await pbxMissedReportingService.getHourly({
      query: parsed.value,
      internalNumbers: cachedInternalNumbers,
      livePbxByHour: cumulativeMissedByHour,
    }));
  } catch (err) {
    req.log.error(err, "vos missed-hourly error");
    res.status(500).json({ error: "PBX hourly report is temporarily unavailable." });
  }
});

router.get("/vos/missed-daily", async (req, res) => {
  try {
    res.json(await pbxMissedReportingService.getDaily({
      query: parsePbxDailyQuery(req.query),
      internalNumbers: cachedInternalNumbers,
      liveRingGroupMissed: ringGroupMissedCache,
      ringGroupNames: ringGroupNameCache,
    }));
  } catch (err) {
    req.log.error(err, "vos missed-daily error");
    res.status(500).json({ error: "PBX daily report is temporarily unavailable." });
  }
});

router.get("/vos/missed-breakdown", async (req, res) => {
  try {
    const parsed = parsePbxBreakdownQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(await pbxMissedReportingService.getBreakdown({
      actor: req.user!,
      query: parsed.value,
      internalNumbers: cachedInternalNumbers,
    }));
  } catch (err) {
    req.log.error(err, "vos missed-breakdown error");
    res.status(500).json({ error: "PBX historical breakdown is temporarily unavailable." });
  }
});

router.get("/vos/callback-review", async (req, res) => {
  try {
    const fromParam = typeof req.query["from"] === "string" ? req.query["from"] : null;
    const toParam = typeof req.query["to"] === "string" ? req.query["to"] : null;

    let missedWhereTime: ReturnType<typeof sql>;
    let cbWindowStart: Date;
    let cbWindowEnd: Date;

    if ((fromParam && !toParam) || (!fromParam && toParam)) {
      res.status(400).json({ error: "Both from and to are required." });
      return;
    }

    if (fromParam && toParam) {
      const range = validateIntegrationDateRange(fromParam, toParam, 90);
      if (!range.ok) {
        res.status(400).json({ error: range.error });
        return;
      }
      missedWhereTime = sql`AND (created_at AT TIME ZONE 'America/Los_Angeles')::date BETWEEN ${fromParam}::date AND ${toParam}::date`;
      cbWindowStart = new Date(fromParam + "T00:00:00Z");
      cbWindowStart.setDate(cbWindowStart.getDate() - 1);
      cbWindowEnd = new Date(toParam + "T23:59:59Z");
      cbWindowEnd.setDate(cbWindowEnd.getDate() + 3);
    } else {
      const days = parseBoundedInteger(req.query["days"], 14, { min: 1, max: 90 });
      if (days === null) {
        res.status(400).json({ error: "Invalid days; expected an integer from 1 to 90." });
        return;
      }
      const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      missedWhereTime = sql`AND created_at >= ${windowStart}`;
      cbWindowStart = windowStart;
      cbWindowEnd = new Date();
      cbWindowEnd.setDate(cbWindowEnd.getDate() + 3);
    }

    const blocklist = await getBlockedNumbers();

    const teamLinesInList = sql.join(TEAM_QUO_LINES.map((l) => sql`${l}`), sql`, `);
    const internalExclude = cachedInternalNumbers.length > 0
      ? sql`AND participant NOT IN (${sql.join(cachedInternalNumbers.map(n => sql`${n}`), sql`, `)})`
      : sql``;

    // All Quo missed calls in window (excluding internal/blocked)
    const quoMissedRaw = await db.execute(sql`
      SELECT id, participant, line_team, line_name, created_at, duration_seconds, ring_duration_seconds, status
      FROM phone_calls
      WHERE direction = 'incoming'
        AND status IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief')
        AND line_name IN (${teamLinesInList})
        ${missedWhereTime}
        AND participant ~ '^[^a-zA-Z]+$'
        ${internalExclude}
      ORDER BY created_at DESC
      LIMIT 2000
    `);

    // All PBX missed calls in window
    const pbxMissedRaw = await db.execute(sql`
      SELECT id, from_number, team, ring_group_name, created_at
      FROM pbx_missed_calls
      WHERE 1=1
        ${missedWhereTime}
        AND team IN ('retention', 'cs', 'nsf')
      ORDER BY created_at DESC
      LIMIT 2000
    `);

    type QuoRow = { id: string; participant: string; line_team: string; line_name: string; created_at: Date; duration_seconds: number | null; ring_duration_seconds: number | null; status: string };
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
    type CbEntryReview = { date: Date; connected: boolean };
    const callbackMap = new Map<string, CbEntryReview[]>();
    if (allRawNumbers.size > 0) {
      const rawList = sql.join(Array.from(allRawNumbers).map(n => sql`${n}`), sql`, `);
      const outboundRaw = await db.execute(sql`
        SELECT participant, created_at, duration_seconds, post_answer_seconds
        FROM phone_calls
        WHERE direction = 'outgoing'
          AND created_at >= ${cbWindowStart}
          AND created_at <= ${cbWindowEnd}
          AND participant IN (${rawList})
        ORDER BY created_at ASC
      `);
      type OutRow2 = { participant: string; created_at: Date; duration_seconds: number; post_answer_seconds: number | null };
      for (const r of outboundRaw.rows as OutRow2[]) {
        const norm = normalizePhone(r.participant);
        if (!norm) continue;
        if (!callbackMap.has(norm)) callbackMap.set(norm, []);
        const talkSecs = r.post_answer_seconds ?? r.duration_seconds ?? 0;
        callbackMap.get(norm)!.push({ date: new Date(r.created_at), connected: talkSecs > 60 });
      }
    }

    type CbEntry2 = { date: Date; connected: boolean };
    type ReviewItem = {
      id: string; fromNumber: string; team: string; source: "quo" | "pbx";
      ringGroupName: string; missedAt: string; isGhost: boolean; hasCallback: boolean;
      callbackConnected: boolean; callbackAt: string | null; responseMinutes: number | null;
    };
    const items: ReviewItem[] = [];

    for (const r of quoMissed) {
      if (blocklist.has(r.participant)) continue;
      const norm = normalizePhone(r.participant);
      if (!norm) continue;
      const missedAt = new Date(r.created_at);
      const callbacks = callbackMap.get(norm) as CbEntry2[] | undefined;
      const cbEntry = callbacks?.find(c => c.date >= missedAt) ?? null;
      items.push({
        id: `quo-${r.id}`,
        fromNumber: r.participant,
        team: r.line_team,
        source: "quo",
        ringGroupName: r.line_name,
        missedAt: missedAt.toISOString(),
        isGhost: KNOWN_GHOST_NUMBERS.has(norm) || (() => {
          const ringDur = r.ring_duration_seconds;
          if (ringDur != null) return ringDur <= 2;
          const dur = r.duration_seconds ?? 0;
          return (r.status === 'no-answer' && dur === 0) ||
                 (r.status === 'voicemail' && dur === 0) ||
                 (r.status === 'voicemail-brief' && dur <= 4);
        })(),
        hasCallback: !!cbEntry,
        callbackConnected: cbEntry?.connected ?? false,
        callbackAt: cbEntry?.date.toISOString() ?? null,
        responseMinutes: cbEntry ? Math.round((cbEntry.date.getTime() - missedAt.getTime()) / 60000) : null,
      });
    }

    for (const r of pbxMissed) {
      if (blocklist.has(r.from_number)) continue;
      const norm = normalizePhone(r.from_number);
      if (!norm) continue;
      const missedAt = new Date(r.created_at);
      const callbacks = callbackMap.get(norm) as CbEntry2[] | undefined;
      const cbEntry = callbacks?.find(c => c.date >= missedAt) ?? null;
      items.push({
        id: `pbx-${r.id}`,
        fromNumber: r.from_number,
        team: r.team,
        source: "pbx",
        ringGroupName: r.ring_group_name,
        missedAt: missedAt.toISOString(),
        isGhost: false,
        hasCallback: !!cbEntry,
        callbackConnected: cbEntry?.connected ?? false,
        callbackAt: cbEntry?.date.toISOString() ?? null,
        responseMinutes: cbEntry ? Math.round((cbEntry.date.getTime() - missedAt.getTime()) / 60000) : null,
      });
    }

    items.sort((a, b) => new Date(b.missedAt).getTime() - new Date(a.missedAt).getTime());

    const visibleItems = isAdministrator(req.user!)
      ? items
      : items.filter((item) => (
          item.team === "retention" || item.team === "nsf" || item.team === "cs" || item.team === "killers"
        ) && canAccessFullTeam(req.user!, item.team as MetricTeam));
    const realItems = visibleItems.filter(i => !i.isGhost);
    const withCallback = realItems.filter(i => i.hasCallback).length;
    const connected = realItems.filter(i => i.callbackConnected).length;
    const rate = realItems.length > 0 ? withCallback / realItems.length : 0;
    const connectRate = withCallback > 0 ? connected / withCallback : 0;
    const responseTimes = realItems.filter(i => i.responseMinutes !== null).map(i => i.responseMinutes!);
    const avgResponseMinutes = responseTimes.length > 0
      ? Math.round(responseTimes.reduce((s, m) => s + m, 0) / responseTimes.length)
      : 0;

    res.json({
      items: visibleItems,
      stats: {
        total: realItems.length,
        ghost: visibleItems.filter(i => i.isGhost).length,
        withCallback, connected,
        rate: Math.round(rate * 100) / 100,
        connectRate: Math.round(connectRate * 100) / 100,
        avgResponseMinutes,
      },
    });
  } catch (err) {
    req.log.error(err, "vos callback-review error");
    res.status(500).json({ error: "PBX callback report is temporarily unavailable." });
  }
});

router.get("/vos/live", async (req, res) => {
  try {
    res.json(await retentionPbxService.getLive(req.user!));
  } catch (err) {
    req.log.error(err, "vos live error");
    res.status(500).json({ error: "PBX live calls are temporarily unavailable." });
  }
});

router.get("/vos/debug/calls", requireRole("admin"), async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const data = await fetchPbxJson<{ calls: VosCallRaw[]; total: number }>(
      `/api/calls${qs ? `?${qs}` : ""}`
    );
    res.json({ total: data.total, calls: data.calls });
  } catch (err) {
    req.log.error(err, "vos debug error");
    res.status(500).json({ error: "PBX diagnostic request failed." });
  }
});

router.get("/vos/debug/proxy", requireRole("admin"), async (req, res) => {
  try {
    const path = approvedVosDebugPath(req.query["path"] ?? "/api/calls?limit=1");
    if (!path) {
      res.status(400).json({ error: "PBX diagnostic path is not approved." });
      return;
    }
    const data = await fetchPbxJson<unknown>(path);
    res.json(data);
  } catch (err) {
    req.log.error(err, "vos debug proxy error");
    res.status(500).json({ error: "PBX diagnostic request failed." });
  }
});

export default router;
