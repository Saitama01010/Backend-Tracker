import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { db, phoneCallsTable, pool } from "@workspace/db";
import { and, eq, gte, lte, desc, ne } from "drizzle-orm";
import { getSyncState, USER_EMAIL_OVERRIDES, USER_ID_OVERRIDES, canonicalAgentName } from "./quoSync.js";
import { getBlockedNumbers } from "../lib/blockedNumbers.js";
import { logger } from "../lib/logger.js";
import { liveWebhookCalls } from "./quoWebhook.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { canAccessDateRange, canAccessMetricTeam, type MetricTeam } from "../middleware/authorizationCore.js";
import {
  authorizationAgent,
  canAccessLiveAgent,
  canAccessMetricAgent,
  loadAuthorizationAgentDirectory,
} from "../lib/authorizationScope.js";
import {
  MAX_QUO_SYNC_DAYS,
  paginateAuthorizedBatches,
  parseBoundedInteger,
  validateIntegrationDateRange,
} from "../lib/externalIntegrationPolicy.js";
import { postgresBackgroundJobStore } from "../lib/backgroundJobStore.js";
import { manualJobKey } from "../lib/durableBackgroundJobs.js";
import { getDurableRuntimeState, listDurableRuntimeState, putDurableRuntimeState } from "../lib/durableRuntimeState.js";
import { OPERATIONAL_CONFIG } from "../lib/operationalConfig.js";
import { businessDayWindow } from "../lib/businessTime.js";

const router: IRouter = Router();
router.use("/quo", requireAuth);

// ─── California date helpers ──────────────────────────────────────────────────
// All stats are grouped and filtered by California (Pacific) date so they match
// what the OpenPhone admin panel shows.

/** Format a UTC Date as a YYYY-MM-DD string in California time. */
function toCaDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: OPERATIONAL_CONFIG.businessTimeZone });
}

/**
 * Given a YYYY-MM-DD string treated as a California calendar date, return the
 * UTC [from, to) bounds that span exactly that California day.
 * Handles PDT (UTC-7) and PST (UTC-8) automatically.
 */
function caDateBounds(dateStr: string): { from: Date; to: Date } {
  const { start, endExclusive } = businessDayWindow(dateStr);
  return { from: start, to: endExclusive };
}

/**
 * Parse `from` / `to` query-param strings into UTC Date bounds.
 * Date-only strings (YYYY-MM-DD) are treated as California calendar dates so
 * the query window matches what agents and OpenPhone show locally.
 */
function parseDateRange(from: string, to: string): { fromDate: Date; toDate: Date } {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const fromDate = DATE_RE.test(from) ? caDateBounds(from).from : new Date(from);
  const toDate   = DATE_RE.test(to)   ? caDateBounds(to).to   : new Date(to);
  return { fromDate, toDate };
}

function effectiveCallStatus(row: {
  status: string;
  direction: string;
  durationSeconds: number;
  postAnswerSeconds?: number | null;
}): string {
  if (row.status !== "completed") return row.status;

  if (row.direction === "outgoing") {
    const pas = row.postAnswerSeconds;
    if (pas !== null && pas !== undefined) {
      if (pas >= 60) return "completed";
      if (pas >= 20) return "voicemail";
      return "voicemail-brief";
    }

    const dur = row.durationSeconds;
    if (dur >= 75) return "completed";
    if (dur >= 35) return "voicemail";
    return "voicemail-brief";
  }

  // Old webhook rows for inbound voicemail were sometimes saved as
  // completed with zero talk time. Do not count those as answered.
  if (row.direction === "incoming" && row.durationSeconds === 0 && row.postAnswerSeconds == null) {
    return "voicemail-brief";
  }

  return "completed";
}

const QUO_BASE = "https://api.openphone.com/v1";
// Keep the live scan below Quo's shared workspace allowance. This route may
// overlap with a scheduled/manual historical sync, so leave headroom rather
// than attempting to consume the provider's documented ceiling.
const QUO_MIN_REQUEST_INTERVAL_MS = 400;
const QUO_MAX_RATE_LIMIT_RETRIES = 4;
let nextQuoRequestAt = 0;
let quoRequestGate: Promise<void> = Promise.resolve();

async function delayForQuo(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function quoHeaders(): Record<string, string> {
  const key = (process.env["QUO_API_KEY"] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!key) throw new Error("QUO_API_KEY not configured");
  return { Authorization: key, Accept: "application/json" };
}

async function waitForQuoRequestSlot(signal?: AbortSignal): Promise<void> {
  let release!: () => void;
  const previous = quoRequestGate;
  quoRequestGate = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    signal?.throwIfAborted();
    const waitMs = Math.max(0, nextQuoRequestAt - Date.now());
    if (waitMs > 0) await delayForQuo(waitMs, signal);
    nextQuoRequestAt = Date.now() + QUO_MIN_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

async function quoFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const request = async () => {
    await waitForQuoRequestSlot(signal);
    return fetch(`${QUO_BASE}${path}`, { headers: quoHeaders(), signal });
  };

  let res = await request();
  for (let attempt = 0; res.status === 429 && attempt < QUO_MAX_RATE_LIMIT_RETRIES; attempt++) {
    const retryAfter = res.headers.get("retry-after");
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const dateDelay = retryAfter && !Number.isFinite(seconds)
      ? Date.parse(retryAfter) - Date.now()
      : Number.NaN;
    const providerDelay = Number.isFinite(seconds) ? seconds * 1_000 : dateDelay;
    const retryDelayMs = Number.isFinite(providerDelay)
      ? Math.min(30_000, Math.max(1_000, providerDelay))
      : Math.min(8_000, 1_000 * (2 ** attempt));
    await delayForQuo(retryDelayMs, signal);
    res = await request();
  }
  if (!res.ok) {
    throw new Error(`Quo API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface QuoPhoneNumber {
  id: string;
  name: string;
  formattedNumber: string;
  number: string;
  users: { id: string; firstName: string; lastName: string; email: string }[];
}

// Exact line name → team (mirrors quoSync.ts LINE_TEAM_MAP)
const LINE_TEAM_MAP = OPERATIONAL_CONFIG.lineTeamMap;

function classifyLine(name: string): "retention" | "nsf" | "cs" | null {
  const n = name.toLowerCase().trim();
  if (n in LINE_TEAM_MAP) return LINE_TEAM_MAP[n];
  if (/\bcs\b|customer support|talia|hiba|nourhan|rasha|bassant|ella monroe/.test(n) || name === "CS Team") return "cs";
  if (/retention|ob|outbound|ryan|abdlrhman|rick|zeiad|zack|henry.?hart|katherine|karma/.test(n)) return "retention";
  if (/nsf|national settlement|ellie|alex|katie|jenny|estella|rika|austin/.test(n)) return "nsf";
  return null;
}

// Agent-name → team override. Calls are bucketed by who made them, not which line
// they used. This ensures agents who call from shared/unclassified lines still
// appear in the correct team bucket.
const AGENT_TEAM: Record<string, "retention" | "nsf" | "cs"> = {
  // Retention — current roster (May 2026)
  "ryan henderson":    "retention",
  "henry hart":        "retention",
  "katherine adams":   "retention",
  "jacob stephenson":  "retention",
  "abdulrhman isawi":  "retention",
  "rick miller":       "retention",
  "zeiad fouad":       "retention",
  "max francis":       "retention",
  "mohammed ayman":    "retention",
  "leo carter":        "cs",
  "fares":             "cs",
  // NSF
  "alex cruz":         "nsf",
  "austin white":      "nsf",
  "rika hart":         "nsf",
  "jenny morgan":      "nsf",
  "estella cruz":      "nsf",
  "katie miller":      "nsf",
  "ellie moser":       "nsf",
  // Retention — agents moved from CS
  "ahmed ayman":       "retention",
  "levi miller":       "retention",
  "michael belfort":   "retention",
  "talia morgan":      "retention",
  // CS
  "chase miller":      "cs",
  "nour eldin atef":   "cs",
  "youssef nady":      "cs",
  "jacob xander":      "cs",
  "ella monroe":       "cs",
  "nora adam":         "cs",
  "carla bennet":      "cs",
};

function agentTeam(agentName: string): "retention" | "nsf" | "cs" | null {
  const key = agentName.toLowerCase().trim();
  return AGENT_TEAM[key] ?? null;
}

function inferAgentFromLine(lineName: string): string | null {
  const line = lineName.toLowerCase().replace(/\s+/g, " ").trim();
  for (const name of Object.keys(AGENT_TEAM)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(line)) return name.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const mappedTeamLine = Object.keys(LINE_TEAM_MAP).find((known) => line.includes(known));
  if (mappedTeamLine) {
    const parts = mappedTeamLine.split("-").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (AGENT_TEAM[part]) return part.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

router.get("/quo/lines", async (req, res) => {
  try {
    const result = await quoFetch<{ data: QuoPhoneNumber[] }>("/phone-numbers");
    const classified = (result.data ?? [])
      .map((p) => ({ ...p, team: classifyLine(p.name) }))
      .filter((p) => p.team !== null);
    res.json({ data: classified });
  } catch (err) {
    req.log.error(err, "quo lines error");
    res.status(500).json({ error: "Quo lines are temporarily unavailable." });
  }
});

router.get("/quo/all-lines", async (req, res) => {
  try {
    const result = await quoFetch<{ data: QuoPhoneNumber[] }>("/phone-numbers");
    const lines = (result.data ?? [])
      .filter((p) => !p.name.toLowerCase().includes("tax"))
      .map((p) => ({ ...p, team: classifyLine(p.name) }));
    res.json({ data: lines });
  } catch (err) {
    req.log.error(err, "quo all-lines error");
    res.status(500).json({ error: "Quo lines are temporarily unavailable." });
  }
});

router.get("/quo/line-stats", async (req, res) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : new Date(Date.now() - 30 * 86400000).toISOString();
    const to = typeof req.query["to"] === "string" ? req.query["to"] : new Date().toISOString();
    const lineId = typeof req.query["lineId"] === "string" ? req.query["lineId"] : undefined;

    if (!lineId || lineId.length > 128) {
      res.status(400).json({ error: "lineId is required" });
      return;
    }

    const range = validateIntegrationDateRange(from, to);
    if (!range.ok) {
      res.status(400).json({ error: range.error });
      return;
    }

    const { fromDate, toDate } = parseDateRange(range.from, range.to);

    const rows = await db
      .select({
        agentName: phoneCallsTable.agentName,
        participant: phoneCallsTable.participant,
        direction: phoneCallsTable.direction,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        postAnswerSeconds: phoneCallsTable.postAnswerSeconds,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(and(eq(phoneCallsTable.lineId, lineId), gte(phoneCallsTable.createdAt, fromDate), lte(phoneCallsTable.createdAt, toDate), ne(phoneCallsTable.status, "in-progress")));

    type Slot = {
      outbound: number; inbound: number; answered: number; missed: number;
      voicemail: number; vmBrief: number; totalCalls: number; talkSeconds: number;
      uniqueContacts: Set<string>;
    };

    const agentStats: Record<string, Record<string, Slot>> = {};
    const agentLastCall: Record<string, Date> = {};
    // Track unique contacts across the FULL date range per agent (not per day)
    // so the total "CX Reached" is truly deduplicated.
    const agentUniqueContactsAll: Record<string, Set<string>> = {};
    const blocklist = await getBlockedNumbers();
    const lineInbounds = { total: 0, answered: 0, missed: 0, voicemail: 0 };

    for (const row of rows) {
      if (row.participant && blocklist.has(row.participant)) continue;
      const effectiveStatus = effectiveCallStatus(row);
      // Track ALL inbound calls at the line level regardless of attribution
      if (row.direction === "incoming") {
        lineInbounds.total++;
        if (effectiveStatus === "completed") lineInbounds.answered++;
        else if (effectiveStatus === "voicemail") lineInbounds.voicemail++;
        else lineInbounds.missed++;
      }

      const agentName = canonicalAgentName(row.agentName) ?? "Unknown";
      const date = toCaDate(row.createdAt);

      if (!agentStats[agentName]) agentStats[agentName] = {};
      if (!agentStats[agentName][date]) {
        agentStats[agentName][date] = {
          outbound: 0, inbound: 0, answered: 0, missed: 0,
          voicemail: 0, vmBrief: 0, totalCalls: 0, talkSeconds: 0, uniqueContacts: new Set(),
        };
      }
      const slot = agentStats[agentName][date];
      slot.totalCalls++;
      slot.talkSeconds += row.durationSeconds;

      if (row.participant) {
        // Per-day unique contacts — both inbound and outbound (for "by day" sub-tab)
        slot.uniqueContacts.add(row.participant);
        // Cross-range unique (for totals column)
        if (!agentUniqueContactsAll[agentName]) agentUniqueContactsAll[agentName] = new Set();
        agentUniqueContactsAll[agentName].add(row.participant);
      }
      const endTime = new Date(row.createdAt.getTime() + row.durationSeconds * 1000);
      if (!agentLastCall[agentName] || endTime > agentLastCall[agentName]) {
        agentLastCall[agentName] = endTime;
      }

      if (row.direction === "outgoing") slot.outbound++;
      else slot.inbound++;

      if (effectiveStatus === "completed") slot.answered++;
      else if (effectiveStatus === "voicemail") slot.voicemail++;
      else if (effectiveStatus === "voicemail-brief") slot.vmBrief++;
      else slot.missed++;
    }

    const serializedStats: Record<string, Record<string, unknown>> = {};
    for (const [agent, days] of Object.entries(agentStats)) {
      serializedStats[agent] = {};
      for (const [date, slot] of Object.entries(days)) {
        serializedStats[agent][date] = { ...slot, uniqueContacts: slot.uniqueContacts.size };
      }
    }

    const serializedLastCall: Record<string, string> = {};
    for (const [agent, ts] of Object.entries(agentLastCall)) {
      serializedLastCall[agent] = ts.toISOString();
    }

    // True unique contacts across the full date range per agent
    const serializedUniqueAll: Record<string, number> = {};
    for (const [agent, set] of Object.entries(agentUniqueContactsAll)) {
      serializedUniqueAll[agent] = set.size;
    }

    res.json({ agentStats: serializedStats, agentLastCall: serializedLastCall, lineInbounds, agentUniqueContactsAll: serializedUniqueAll });
  } catch (err) {
    req.log.error(err, "quo line-stats error");
    res.status(500).json({ error: "Quo line statistics are temporarily unavailable." });
  }
});

router.get("/quo/stats", async (req, res) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : new Date(Date.now() - 30 * 86400000).toISOString();
    const to = typeof req.query["to"] === "string" ? req.query["to"] : new Date().toISOString();
    if (!canAccessDateRange(req.user!, [from, to])) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const range = validateIntegrationDateRange(from, to);
    if (!range.ok) {
      res.status(400).json({ error: range.error });
      return;
    }
    const { fromDate, toDate } = parseDateRange(range.from, range.to);

    const rows = await db
      .select({
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        lineId: phoneCallsTable.lineId,
        agentName: phoneCallsTable.agentName,
        agentId: phoneCallsTable.agentId,
        participant: phoneCallsTable.participant,
        direction: phoneCallsTable.direction,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        postAnswerSeconds: phoneCallsTable.postAnswerSeconds,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.createdAt, fromDate), lte(phoneCallsTable.createdAt, toDate), ne(phoneCallsTable.status, "in-progress")));

    const directory = req.user!.role === "admin" ? null : await loadAuthorizationAgentDirectory();
    const scopedRows = directory
      ? rows.filter((row) => {
          const agentName = canonicalAgentName(row.agentName) ?? inferAgentFromLine(row.lineName) ?? "Unknown";
          const rawTeam = agentTeam(agentName) ?? row.lineTeam;
          const fallbackTeam = rawTeam === "retention" || rawTeam === "nsf" || rawTeam === "cs" ? rawTeam : null;
          return canAccessMetricAgent(req.user!, agentName, directory, fallbackTeam);
        })
      : rows;

    const teamStats: Record<
      string,
      Record<
        string,
        Record<
          string,
          {
            outbound: number;
            inbound: number;
            answered: number;
            missed: number;
            voicemail: number;
            vmBrief: number;
            totalCalls: number;
            talkSeconds: number;
            uniqueContacts: Set<string>;
          }
        >
      >
    > = { retention: {}, nsf: {}, cs: {}, other: {} };

    const agentLastCall: Record<string, Record<string, Date>> = {};
    const allAgentStats: Record<
      string,
      Record<
        string,
        {
          outbound: number;
          inbound: number;
          answered: number;
          missed: number;
          voicemail: number;
          vmBrief: number;
          totalCalls: number;
          talkSeconds: number;
          uniqueContacts: Set<string>;
        }
      >
    > = {};
    const allAgentLastCall: Record<string, Date> = {};

    const lineInbound: Record<
      string,
      Record<string, { lineId: string; lineName: string; received: number; answered: number; missed: number; voicemail: number }>
    > = {};

    const blocklist = await getBlockedNumbers();
    for (const row of scopedRows) {
      if (row.participant && blocklist.has(row.participant)) continue;
      const agentName = canonicalAgentName(row.agentName) ?? inferAgentFromLine(row.lineName) ?? "Unknown";
      // Agent-based team takes priority over line-based. Calls that don't map to a
      // tracked team (e.g. Onboarding / unclassified lines) fall into "other" so
      // they are still counted and visible to Samia, instead of being silently
      // dropped (which made per-agent totals wildly undercount agents who work
      // mainly on unclassified lines). The dashboard reads fixed team keys
      // (retention/nsf/cs), so the extra "other" bucket does not affect it.
      let team = agentTeam(agentName) ?? row.lineTeam ?? "other";
      if (!(team in teamStats)) team = "other";
      const date = toCaDate(row.createdAt);
      const effectiveStatus = effectiveCallStatus(row);

      if (!teamStats[team]) teamStats[team] = {};
      if (!teamStats[team][agentName]) teamStats[team][agentName] = {};
      if (!teamStats[team][agentName][date]) {
        teamStats[team][agentName][date] = {
          outbound: 0, inbound: 0, answered: 0, missed: 0,
          voicemail: 0, vmBrief: 0, totalCalls: 0, talkSeconds: 0, uniqueContacts: new Set(),
        };
      }
      const slot = teamStats[team][agentName][date];
      slot.totalCalls++;
      slot.talkSeconds += row.durationSeconds;
      // "CX Reached" = unique phone numbers spoken with, inbound OR outbound (skip blanks)
      if (row.participant) slot.uniqueContacts.add(row.participant);
      if (!agentLastCall[team]) agentLastCall[team] = {};
      const endTimeTeam = new Date(row.createdAt.getTime() + row.durationSeconds * 1000);
      if (!agentLastCall[team][agentName] || endTimeTeam > agentLastCall[team][agentName]) {
        agentLastCall[team][agentName] = endTimeTeam;
      }
      if (!allAgentStats[agentName]) allAgentStats[agentName] = {};
      if (!allAgentStats[agentName][date]) {
        allAgentStats[agentName][date] = {
          outbound: 0, inbound: 0, answered: 0, missed: 0,
          voicemail: 0, vmBrief: 0, totalCalls: 0, talkSeconds: 0, uniqueContacts: new Set(),
        };
      }
      const allSlot = allAgentStats[agentName][date];
      allSlot.totalCalls++;
      allSlot.talkSeconds += row.durationSeconds;
      if (row.participant) allSlot.uniqueContacts.add(row.participant);
      if (!allAgentLastCall[agentName] || endTimeTeam > allAgentLastCall[agentName]) {
        allAgentLastCall[agentName] = endTimeTeam;
      }
      if (row.direction === "outgoing") allSlot.outbound++;
      else allSlot.inbound++;
      if (effectiveStatus === "completed") allSlot.answered++;
      else if (effectiveStatus === "voicemail") allSlot.voicemail++;
      else if (effectiveStatus === "voicemail-brief") allSlot.vmBrief++;
      else allSlot.missed++;

      if (row.direction === "outgoing") slot.outbound++;
      else slot.inbound++;

      if (effectiveStatus === "completed") slot.answered++;
      else if (effectiveStatus === "voicemail") slot.voicemail++;
      else if (effectiveStatus === "voicemail-brief") slot.vmBrief++;
      else slot.missed++;

      if (row.direction === "incoming") {
        if (!lineInbound[row.lineId]) lineInbound[row.lineId] = {};
        if (!lineInbound[row.lineId][date]) {
          lineInbound[row.lineId][date] = { lineId: row.lineId, lineName: row.lineName, received: 0, answered: 0, missed: 0, voicemail: 0 };
        }
        const lb = lineInbound[row.lineId][date];
        lb.received++;
        if (effectiveStatus === "completed") lb.answered++;
        else if (effectiveStatus === "voicemail") lb.voicemail++;
        else lb.missed++;
      }
    }

    const serializeStats = () => {
      const out: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const [team, agents] of Object.entries(teamStats)) {
        out[team] = {};
        for (const [agent, days] of Object.entries(agents)) {
          out[team][agent] = {};
          for (const [date, slot] of Object.entries(days)) {
            out[team][agent][date] = { ...slot, uniqueContacts: slot.uniqueContacts.size };
          }
        }
      }
      return out;
    };

    const serializeAllAgentStats = () => {
      const out: Record<string, Record<string, unknown>> = {};
      for (const [agent, days] of Object.entries(allAgentStats)) {
        out[agent] = {};
        for (const [date, slot] of Object.entries(days)) {
          out[agent][date] = { ...slot, uniqueContacts: slot.uniqueContacts.size };
        }
      }
      return out;
    };

    const syncState = await getSyncState();

    const agentLastCallSerialized: Record<string, Record<string, string>> = {};
    for (const [team, agents] of Object.entries(agentLastCall)) {
      agentLastCallSerialized[team] = {};
      for (const [agent, ts] of Object.entries(agents)) {
        agentLastCallSerialized[team][agent] = ts.toISOString();
      }
    }
    const allAgentLastCallSerialized: Record<string, string> = {};
    for (const [agent, ts] of Object.entries(allAgentLastCall)) {
      allAgentLastCallSerialized[agent] = ts.toISOString();
    }

    res.json({
      teamStats: serializeStats(),
      allAgentStats: serializeAllAgentStats(),
      lineInbound,
      agentLastCall: agentLastCallSerialized,
      allAgentLastCall: allAgentLastCallSerialized,
      totalRows: scopedRows.length,
      lastSyncedAt: syncState?.lastSyncedAt ?? null,
      isSyncing: syncState?.isSyncing ?? false,
    });
  } catch (err) {
    req.log.error(err, "quo stats error");
    res.status(500).json({ error: "Quo statistics are temporarily unavailable." });
  }
});

router.post("/quo/sync", requireRole("admin"), async (req, res) => {
  try {
    const from = typeof req.body?.from === "string" ? req.body.from : new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const to = typeof req.body?.to === "string" ? req.body.to : new Date().toISOString();
    const range = validateIntegrationDateRange(from, to, MAX_QUO_SYNC_DAYS);
    if (!range.ok) {
      res.status(400).json({ error: range.error });
      return;
    }
    await postgresBackgroundJobStore.enqueue({
      jobType: "quo_sync",
      idempotencyKey: manualJobKey("quo_sync", req.user!.userId),
      payload: { from: range.from, to: range.to },
      requestedByUserId: req.user!.userId,
      priority: 90,
      maxAttempts: 4,
    });
    req.log.info({ from: range.from, to: range.to }, "quo sync queued manually");
    res.json({ success: true, message: "Sync started in background", from: range.from, to: range.to });
  } catch (err) {
    req.log.error(err, "quo sync error");
    res.status(500).json({ error: "Quo sync could not be started." });
  }
});

router.get("/quo/sync-state", async (req, res) => {
  try {
    const state = await getSyncState();
    res.json(state ?? { id: "singleton", lastSyncedAt: null, isSyncing: false });
  } catch (err) {
    req.log.error(err, "quo sync state error");
    res.status(500).json({ error: "Quo sync state is temporarily unavailable." });
  }
});

// ─── Live-call detection ───────────────────────────────────────────────────────
// Three sources merged in /quo/live:
//   1. Webhook state   — instant (set by quoWebhook.ts on call.ringing / call.answered)
//   2. Poll state      — request-driven shared poll; queries conversations updated in
//                        the last 5 min, then fetches calls for each to find in-progress
//   3. DB fallback     — catches calls synced by the 15-min background sync

// ─── Request-driven live poller ────────────────────────────────────────────────
// Finds in-progress calls by scanning conversations updated in the last 5 minutes.
// Fills the gap between webhook events (often not configured) and the 15-min DB sync.
const pollLiveAgents = new Set<string>();
/** agentName → external participant number for the current in-progress call */
const pollLiveParticipants = new Map<string, string>();
let livePollRunning = false;
const LIVE_POLL_STATE_KEY = "quo:live-poll";
const LIVE_POLL_LEASE_KEY = "quo:live-poll-lease";
const LIVE_POLL_TTL_MS = 45_000;
const LIVE_POLL_TIMEOUT_MS = 90_000;
const LIVE_POLL_LEASE_MS = 105_000;

type LivePollSnapshot = {
  active: string[];
  agentCalls: Array<{ agentName: string; participant: string }>;
};

class LivePollRefreshInProgressError extends Error {
  constructor() {
    super("Quo live refresh is already in progress");
    this.name = "LivePollRefreshInProgressError";
  }
}

async function tryAcquireLivePollLease(): Promise<string | null> {
  const owner = randomUUID();
  const result = await pool.query<{ owner: string }>(
    `INSERT INTO durable_runtime_state (key, value, updated_at, expires_at)
     VALUES ($1, jsonb_build_object('owner', $2::text), now(), now() + ($3::bigint * interval '1 millisecond'))
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = EXCLUDED.updated_at,
           expires_at = EXCLUDED.expires_at
       WHERE durable_runtime_state.expires_at IS NULL
          OR durable_runtime_state.expires_at <= now()
     RETURNING value->>'owner' AS owner`,
    [LIVE_POLL_LEASE_KEY, owner, LIVE_POLL_LEASE_MS],
  );
  return result.rows[0]?.owner === owner ? owner : null;
}

async function releaseLivePollLease(owner: string): Promise<void> {
  await pool.query(
    `DELETE FROM durable_runtime_state
     WHERE key = $1 AND value->>'owner' = $2`,
    [LIVE_POLL_LEASE_KEY, owner],
  );
}

export async function runLivePoll(signal?: AbortSignal): Promise<{ active: string[]; agentCalls: Array<{ agentName: string; participant: string }> }> {
  if (livePollRunning) {
    return {
      active: [...pollLiveAgents],
      agentCalls: [...pollLiveParticipants.entries()].map(([agentName, participant]) => ({ agentName, participant })),
    };
  }
  livePollRunning = true;
  try {
    signal?.throwIfAborted();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // Build userId → agentName map AND collect line IDs in one call
    type OPUser = { id: string; firstName: string; lastName: string; email?: string };
    // Paginate /users and /phone-numbers fully — defaults return only first page,
    // which previously caused some agents (e.g. Levi/Ahmed Ayman) and shared lines
    // to be missing from the livePoll resolution.
    async function fetchAllPages<T>(basePath: string): Promise<T[]> {
      const out: T[] = [];
      let pageToken: string | null = null;
      let page = 0;
      do {
        const sep = basePath.includes("?") ? "&" : "?";
        const url: string = `${basePath}${sep}maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const res = await quoFetch<{ data: T[]; nextPageToken?: string | null }>(url, signal);
        out.push(...(res.data ?? []));
        pageToken = res.nextPageToken ?? null;
        page++;
      } while (pageToken && page < 20);
      return out;
    }
    const [usersAll, linesAll] = await Promise.all([
      fetchAllPages<OPUser>("/users"),
      fetchAllPages<{ id: string; users?: OPUser[] }>("/phone-numbers"),
    ]);
    const userMap = new Map<string, string>();
    function addToUserMap(u: OPUser) {
      if (userMap.has(u.id)) return;
      const emailKey = u.email?.toLowerCase().trim() ?? "";
      const override = USER_ID_OVERRIDES[u.id] ?? (emailKey && USER_EMAIL_OVERRIDES[emailKey]);
      userMap.set(u.id, override || `${u.firstName} ${u.lastName}`.trim());
    }
    for (const u of usersAll) addToUserMap(u);
    for (const line of linesAll) for (const u of line.users ?? []) addToUserMap(u);

    const lineIds = new Set<string>(linesAll.map((l) => l.id));

    // Conversations updated in last 5 minutes = potentially active calls
    const convRes = await quoFetch<{
      data: { id: string; phoneNumberId: string; participants: string[] }[];
    }>(`/conversations?updatedAfter=${encodeURIComponent(fiveMinAgo)}&updatedBefore=${encodeURIComponent(now)}&maxResults=100`, signal);

    const newLive = new Set<string>();
    const newParticipants = new Map<string, string>();

    // For each recently-active conversation, check for in-progress calls
    const tasks = (convRes.data ?? [])
      .filter((c) => lineIds.has(c.phoneNumberId) && c.participants?.length > 0)
      .map((c) => async () => {
        const participant = c.participants[0];
        type LiveCall = {
          id: string;
          status: string;
          userId?: string | null;
          participants?: string[];
          users?: { id?: string; firstName?: string; lastName?: string; email?: string }[];
          answeredBy?: string | null;
          // OpenPhone occasionally returns an array of user ids that handled the call.
          userIds?: string[];
        };
        const callsRes = await quoFetch<{ data: LiveCall[] }>(
          `/calls?phoneNumberId=${encodeURIComponent(c.phoneNumberId)}` +
          `&participants[]=${encodeURIComponent(participant)}` +
          `&createdAfter=${encodeURIComponent(fiveMinAgo)}` +
          `&createdBefore=${encodeURIComponent(now)}` +
          `&maxResults=5`,
          signal,
        );

        for (const call of callsRes.data ?? []) {
          if (call.status !== "in-progress") continue;

          // Resolve user via every known shape OpenPhone returns.
          // For INBOUND calls, `userId` is the line owner (often a manager) while
          // `answeredBy` is the agent who actually picked up — same pattern used
          // in quoSync.ts. Prefer answeredBy so we attribute the live call to
          // the agent on the phone, not the line's owner.
          const inlineUser = call.users?.[0];
          if (inlineUser?.id) addToUserMap({
            id: inlineUser.id,
            firstName: inlineUser.firstName ?? "",
            lastName: inlineUser.lastName ?? "",
            email: inlineUser.email,
          });
          const resolvedUserId =
            call.answeredBy ??
            call.userId ??
            call.userIds?.[0] ??
            inlineUser?.id ??
            null;

          if (!resolvedUserId) {
            logger.warn(
              { callId: call.id, phoneNumberId: c.phoneNumberId, participant },
              "quo livePoll: in-progress call with no resolvable user",
            );
            continue;
          }

          const agentName = userMap.get(resolvedUserId) ?? resolvedUserId;
          if (agentName === resolvedUserId) {
            logger.warn(
              { callId: call.id, userId: resolvedUserId, phoneNumberId: c.phoneNumberId },
              "quo livePoll: in-progress user id not in userMap",
            );
          }
          newLive.add(agentName);
          const liveParticipant = call.participants?.[0] ?? participant;
          newParticipants.set(agentName, liveParticipant);
        }
      });

    // Keep per-conversation checks bounded so they do not burst Quo even when
    // another authorized synchronization is using the same workspace quota.
    const limit = 2;
    let idx = 0;
    async function worker() {
      while (idx < tasks.length) {
        signal?.throwIfAborted();
        const task = tasks[idx++];
        if (task) await task();
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));

    pollLiveAgents.clear();
    pollLiveParticipants.clear();
    for (const a of newLive) pollLiveAgents.add(a);
    for (const [a, p] of newParticipants) pollLiveParticipants.set(a, p);

    const snapshot = {
      active: [...newLive],
      agentCalls: [...newParticipants.entries()].map(([agentName, participant]) => ({ agentName, participant })),
    };
    await putDurableRuntimeState(LIVE_POLL_STATE_KEY, snapshot, LIVE_POLL_TTL_MS);

    if (newLive.size > 0) {
      logger.info({ agents: [...newLive] }, "quo livePoll: in-progress calls found");
    }
    return snapshot;
  } catch (err) {
    logger.warn({ err: String(err) }, "quo livePoll: error");
    throw err;
  } finally {
    livePollRunning = false;
  }
}

async function requestDrivenLivePoll(): Promise<LivePollSnapshot> {
  const existing = await getDurableRuntimeState<LivePollSnapshot>(LIVE_POLL_STATE_KEY);
  if (existing) return existing.value;

  const leaseOwner = await tryAcquireLivePollLease();
  if (!leaseOwner) {
    // Another Vercel instance is already refreshing. Wait for its durable
    // snapshot; the expiring row lease self-recovers if that instance freezes.
    for (let attempt = 0; attempt < 180; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const refreshed = await getDurableRuntimeState<LivePollSnapshot>(LIVE_POLL_STATE_KEY);
      if (refreshed) return refreshed.value;
    }
    throw new LivePollRefreshInProgressError();
  }

  try {
    await runLivePoll(AbortSignal.timeout(LIVE_POLL_TIMEOUT_MS));
  } finally {
    await releaseLivePollLease(leaseOwner).catch((error: unknown) => {
      logger.warn({ err: String(error) }, "quo livePoll: unable to release durable lease");
    });
  }

  const refreshed = await getDurableRuntimeState<LivePollSnapshot>(LIVE_POLL_STATE_KEY);
  if (!refreshed) throw new Error("Quo live refresh did not publish state");
  return refreshed.value;
}

router.get("/quo/live", async (req, res) => {
  try {
    const pollSnapshot = await requestDrivenLivePoll();
    const durableWebhookCalls = await listDurableRuntimeState<{
      agentName: string;
      participant: string;
      ringingSince: string;
    }>("quo:webhook-live:");
    const active = new Set<string>();

    // Source 1: webhook in-memory state — instant, set by quoWebhook.ts on call.ringing/answered.
    for (const { agentName } of liveWebhookCalls.values()) active.add(agentName);
    for (const { value } of durableWebhookCalls) active.add(value.agentName);

    // Source 2: shared request-driven poll — finds in-progress calls via conversations API.
    // Covers the gap when webhooks miss an event without relying on a Vercel cron cadence.
    for (const agentName of pollLiveAgents) active.add(agentName);
    for (const agentName of pollSnapshot.active) active.add(agentName);

    // Source 3: DB in-progress rows — catches calls synced by the 15-min background sync.
    const since2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const dbRows = await db
      .select({ agentName: phoneCallsTable.agentName, participant: phoneCallsTable.participant })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.syncedAt, since2h), eq(phoneCallsTable.status, "in-progress")));
    for (const r of dbRows) if (r.agentName) active.add(r.agentName);

    // Build agentName → participant map.
    // Priority: poll (fresh from call record) → DB → webhook (from/to at ring time)
    const agentParticipant = new Map<string, string | null>();
    // Lowest priority first — webhook number at ring time
    for (const { agentName, participant } of liveWebhookCalls.values()) {
      agentParticipant.set(agentName, participant || null);
    }
    for (const { value } of durableWebhookCalls) {
      agentParticipant.set(value.agentName, value.participant || null);
    }
    // Poll participant (from call record, updated each 60s)
    for (const agentName of pollLiveAgents) {
      agentParticipant.set(agentName, pollLiveParticipants.get(agentName) ?? agentParticipant.get(agentName) ?? null);
    }
    for (const call of pollSnapshot.agentCalls) {
      agentParticipant.set(call.agentName, call.participant ?? agentParticipant.get(call.agentName) ?? null);
    }
    // DB participant (most stable — from completed-call upsert)
    for (const r of dbRows) {
      if (r.agentName && r.participant) agentParticipant.set(r.agentName, r.participant);
    }

    req.log.info(
      {
        fromWebhook: liveWebhookCalls.size,
        fromPoll: new Set([...pollLiveAgents, ...pollSnapshot.active]).size,
        total: active.size,
      },
      "quo live"
    );
    if (req.user!.role === "admin") {
      res.json({
        active: [...active],
        agentCalls: [...agentParticipant.entries()].map(([agentName, participant]) => ({ agentName, participant })),
        webhookActive: liveWebhookCalls.size > 0 || durableWebhookCalls.length > 0,
      });
      return;
    }
    const directory = await loadAuthorizationAgentDirectory();
    const scopedActive = [...active].filter((agentName) => canAccessLiveAgent(req.user!, agentName, directory));
    const scopedCalls = [...agentParticipant.entries()]
      .filter(([agentName]) => canAccessLiveAgent(req.user!, agentName, directory))
      .map(([agentName, participant]) => ({ agentName, participant }));
    const scopedWebhookActive = [
      ...[...liveWebhookCalls.values()].map(({ agentName }) => agentName),
      ...durableWebhookCalls.map(({ value }) => value.agentName),
    ].some((agentName) => canAccessLiveAgent(req.user!, agentName, directory));
    res.json({ active: scopedActive, agentCalls: scopedCalls, webhookActive: scopedWebhookActive });
  } catch (err) {
    req.log.error(err, "quo live error");
    if (err instanceof LivePollRefreshInProgressError) {
      res.setHeader("Retry-After", "5");
      res.status(503).json({ error: "Quo live calls are refreshing." });
      return;
    }
    res.status(500).json({ error: "Quo live calls are temporarily unavailable." });
  }
});


router.get("/quo/calls", async (req, res) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : new Date(Date.now() - 30 * 86400000).toISOString();
    const to = typeof req.query["to"] === "string" ? req.query["to"] : new Date().toISOString();
    const team = typeof req.query["team"] === "string" ? req.query["team"] : undefined;
    const limitParam = parseBoundedInteger(req.query["limit"], 500, { min: 1, max: 1_000 });
    const offsetParam = parseBoundedInteger(req.query["offset"], 0, { min: 0, max: 1_000_000 });
    if (limitParam === null || offsetParam === null) {
      res.status(400).json({ error: "Invalid pagination parameters." });
      return;
    }

    if (!canAccessDateRange(req.user!, [from, to])) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const requestedTeam = team as MetricTeam | undefined;
    if (requestedTeam && !["retention", "nsf", "cs", "killers"].includes(requestedTeam)) {
      res.status(400).json({ error: "Invalid team." });
      return;
    }
    if (req.user!.role !== "admin" && (
      !requestedTeam
      || !["retention", "nsf", "cs", "killers"].includes(requestedTeam)
      || !canAccessMetricTeam(req.user!, requestedTeam)
    )) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const range = validateIntegrationDateRange(from, to);
    if (!range.ok) {
      res.status(400).json({ error: range.error });
      return;
    }
    const { fromDate, toDate } = parseDateRange(range.from, range.to);

    const directory = req.user!.role === "admin" ? null : await loadAuthorizationAgentDirectory();
    const isAuthorized = (row: {
      lineTeam: string;
      lineName: string;
      agentName: string | null;
    }) => {
      const agentName = canonicalAgentName(row.agentName) ?? inferAgentFromLine(row.lineName) ?? "Unknown";
      const rawTeam = agentTeam(agentName) ?? row.lineTeam;
      const fallbackTeam = rawTeam === "retention" || rawTeam === "nsf" || rawTeam === "cs" ? rawTeam : null;
      if (!directory) return !team || rawTeam === team;
      const resolvedTeam = authorizationAgent(directory, agentName)?.team ?? fallbackTeam;
      return (!requestedTeam || resolvedTeam === requestedTeam)
        && canAccessMetricAgent(req.user!, agentName, directory, fallbackTeam);
    };
    const paged = await paginateAuthorizedBatches(async (databaseOffset, batchSize) => db
      .select({
        id: phoneCallsTable.id,
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        agentName: phoneCallsTable.agentName,
        participant: phoneCallsTable.participant,
        direction: phoneCallsTable.direction,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.createdAt, fromDate), lte(phoneCallsTable.createdAt, toDate)))
      .orderBy(desc(phoneCallsTable.createdAt), desc(phoneCallsTable.id))
      .limit(batchSize)
      .offset(databaseOffset), isAuthorized, offsetParam, limitParam);

    res.json(paged);
  } catch (err) {
    req.log.error(err, "quo calls error");
    res.status(500).json({ error: "Quo calls are temporarily unavailable." });
  }
});

export { router as quoRouter };
export default router;
