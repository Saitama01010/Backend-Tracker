import { Router, type IRouter, type Request, type Response } from "express";
import { performance } from "node:perf_hooks";
import { db, phoneCallsTable } from "@workspace/db";
import { and, eq, gte, lte, desc, ne } from "drizzle-orm";
import {
  getSyncState,
  canonicalAgentName,
} from "../integrations/quo/sync.js";
import { getBlockedNumbers } from "../lib/blockedNumbers.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { canAccessDateRange, canAccessMetricTeam, isAdministrator, type MetricTeam } from "../middleware/authorizationCore.js";
import {
  authorizationAgent,
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
import { OPERATIONAL_CONFIG } from "../lib/operationalConfig.js";
import { businessDayWindow } from "../lib/businessTime.js";
import { effectivePhoneCallStatus } from "../lib/phoneStatsAggregation.js";
import { fetchQuoPhoneNumbers } from "../integrations/quo/client.js";
import {
  classifyDashboardLine,
  dashboardAgentTeam,
  inferDashboardAgentFromLine,
  type QuoPhoneNumber,
} from "../integrations/quo/dashboardMapper.js";
import {
  retentionQuoStatsDateInput,
  validateRetentionQuoStatsQuery,
} from "../modules/retention/retention.schemas.js";
import { retentionQuoStatsService } from "../modules/retention/retention.quo.service.js";
import {
  LivePollRefreshInProgressError,
  retentionQuoLiveService,
} from "../modules/retention/retention.quo.live.service.js";

export { runLivePoll } from "../modules/retention/retention.quo.live.service.js";

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

const effectiveCallStatus = effectivePhoneCallStatus;

router.get("/quo/lines", async (req, res) => {
  try {
    const classified = (await fetchQuoPhoneNumbers())
      .map((p) => ({ ...p, team: classifyDashboardLine(p.name) }))
      .filter((p) => p.team !== null);
    res.json({ data: classified });
  } catch (err) {
    req.log.error(err, "quo lines error");
    res.status(500).json({ error: "Quo lines are temporarily unavailable." });
  }
});

router.get("/quo/all-lines", async (req, res) => {
  try {
    const lines = (await fetchQuoPhoneNumbers())
      .filter((p) => !p.name.toLowerCase().includes("tax"))
      .map((p) => ({ ...p, team: classifyDashboardLine(p.name) }));
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

export async function legacyQuoStatsHandler(req: Request, res: Response) {
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

    const directory = isAdministrator(req.user!) ? null : await loadAuthorizationAgentDirectory();
    const scopedRows = directory
      ? rows.filter((row) => {
          const agentName = canonicalAgentName(row.agentName) ?? inferDashboardAgentFromLine(row.lineName) ?? "Unknown";
          const rawTeam = dashboardAgentTeam(agentName) ?? row.lineTeam;
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
      const agentName = canonicalAgentName(row.agentName) ?? inferDashboardAgentFromLine(row.lineName) ?? "Unknown";
      // Agent-based team takes priority over line-based. Calls that don't map to a
      // tracked team (e.g. Onboarding / unclassified lines) fall into "other" so
      // they are still counted and visible to Samia, instead of being silently
      // dropped (which made per-agent totals wildly undercount agents who work
      // mainly on unclassified lines). The dashboard reads fixed team keys
      // (retention/nsf/cs), so the extra "other" bucket does not affect it.
      let team = dashboardAgentTeam(agentName) ?? row.lineTeam ?? "other";
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
}

function roundedTiming(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function optimizedQuoStatsHandler(req: Request, res: Response) {
  const requestStartedAt = performance.now();
  try {
    const input = retentionQuoStatsDateInput(req.query);
    if (!canAccessDateRange(req.user!, [input.from, input.to])) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const validation = validateRetentionQuoStatsQuery(input);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const result = await retentionQuoStatsService.getStats({
      actor: req.user!,
      query: validation.query,
    });

    if (result.cache === "hit") {
      const totalMs = roundedTiming(performance.now() - requestStartedAt);
      res.setHeader("Server-Timing", `cache;desc=hit;dur=0, app;dur=${totalMs}`);
      res.setHeader("X-Result-Rows", String(result.totalRows));
      res.setHeader("X-Aggregate-Rows", String(result.aggregateRows));
      res.setHeader("X-Cache", "hit");
      res.type("application/json").send(result.body);
      return;
    }
    const totalMs = roundedTiming(performance.now() - requestStartedAt);

    res.setHeader("Server-Timing", [
      `authz;dur=${result.authorizationMs}`,
      `authn;dur=${req.authTimingMs ?? 0}`,
      `db;dur=${result.databaseMs}`,
      `transform;dur=${result.transformMs}`,
      `serialize;dur=${result.serializeMs}`,
      `app;dur=${totalMs}`,
    ].join(", "));
    res.setHeader("X-Result-Rows", String(result.totalRows));
    res.setHeader("X-Aggregate-Rows", String(result.aggregateRows));
    res.setHeader("X-Cache", result.cache);
    res.type("application/json").send(result.body);
  } catch (err) {
    req.log.error(err, "quo stats error");
    res.status(500).json({ error: "Quo statistics are temporarily unavailable." });
  }
}

router.get("/quo/stats", optimizedQuoStatsHandler);

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
// Status reads stay lightweight; provider refresh remains explicit and request-driven.

export async function legacyQuoLiveHandler(req: Request, res: Response) {
  try {
    const result = await retentionQuoLiveService.getLegacyLiveStatus(req.user!);
    req.log.info(result.diagnostics, "quo live");
    res.json(result.payload);
  } catch (err) {
    req.log.error(err, "quo live error");
    if (err instanceof LivePollRefreshInProgressError) {
      res.setHeader("Retry-After", "5");
      res.status(503).json({ error: "Quo live calls are refreshing." });
      return;
    }
    res.status(500).json({ error: "Quo live calls are temporarily unavailable." });
  }
}

export async function optimizedQuoLiveHandler(req: Request, res: Response) {
  const requestStartedAt = performance.now();
  try {
    const result = await retentionQuoLiveService.getLiveStatus(req.user!);
    const totalMs = roundedTiming(performance.now() - requestStartedAt);
    res.set("Cache-Control", "no-store");
    res.set("X-Data-Stale", result.stale ? "true" : "false");
    res.set("Server-Timing", [
      `db;dur=${result.databaseMs}`,
      `authz;dur=${result.authorizationMs}`,
      `serialize;dur=${result.serializeMs}`,
      `app;dur=${totalMs}`,
    ].join(", "));
    res.type("application/json").send(result.body);
  } catch (err) {
    req.log.error(err, "quo live state error");
    res.status(500).json({ error: "Quo live calls are temporarily unavailable." });
  }
}

router.get("/quo/live", optimizedQuoLiveHandler);

router.get("/quo/live/refresh", async (req, res) => {
  const startedAt = performance.now();
  try {
    await retentionQuoLiveService.requestLiveRefresh();
    res.set("Cache-Control", "no-store");
    res.set("Server-Timing", `provider;dur=${roundedTiming(performance.now() - startedAt)}`);
    res.status(204).end();
  } catch (err) {
    if (err instanceof LivePollRefreshInProgressError) {
      res.set("Retry-After", "5");
      res.status(202).json({ refreshing: true });
      return;
    }
    req.log.error(err, "quo live refresh error");
    res.status(502).json({ error: "Quo live refresh failed." });
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
    if (!isAdministrator(req.user!) && (
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

    const directory = isAdministrator(req.user!) ? null : await loadAuthorizationAgentDirectory();
    const isAuthorized = (row: {
      lineTeam: string;
      lineName: string;
      agentName: string | null;
    }) => {
      const agentName = canonicalAgentName(row.agentName) ?? inferDashboardAgentFromLine(row.lineName) ?? "Unknown";
      const rawTeam = dashboardAgentTeam(agentName) ?? row.lineTeam;
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
