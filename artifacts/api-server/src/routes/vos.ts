import { Router } from "express";
import { db, phoneCallsTable, pbxMissedCallsTable } from "@workspace/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { getBlockedNumbers } from "../lib/blockedNumbers.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  approvedVosDebugPath,
} from "../lib/externalIntegrationPolicy.js";
import { postgresBackgroundJobStore } from "../lib/backgroundJobStore.js";
import { manualJobKey } from "../lib/durableBackgroundJobs.js";
import { OPERATIONAL_CONFIG } from "../lib/operationalConfig.js";
import {
  fetchPbxJson,
  type VosAgent,
  type VosCallRaw,
  type VosDashboard,
  type VosRingGroup,
} from "../integrations/pbx/client.js";
import { teamFromRingGroupName } from "../integrations/pbx/mapper.js";
import { retentionPbxService } from "../modules/retention/retention.pbx.service.js";
import type {
  RetentionPbxCallHistoryStat,
  RetentionPbxRingGroupMissed,
} from "../modules/retention/retention.pbx.types.js";
import {
  parsePbxBreakdownQuery,
  parsePbxCallbackReviewQuery,
  parsePbxDailyQuery,
  parsePbxHourlyQuery,
} from "../modules/pbx/pbx.schemas.js";
import { pbxMissedReportingService } from "../modules/pbx/pbx.missed.service.js";
import {
  addCallback,
  buildPbxMissedNoCallbackItems,
  buildQuoMissedNoCallbackItems,
  pbxNoCallbackService,
  type CallbackEntry,
} from "../modules/pbx/pbx.no-callback.service.js";
import { nsfReadymodeService } from "../modules/nsf/nsf.readymode.service.js";
import { pbxProviderService } from "../modules/pbx/pbx.provider.service.js";
import {
  normalizePhone,
} from "../modules/pbx/pbx.phone.js";
import {
  getCallHistoryCache,
  hydratePbxState,
  pbxRuntimeState,
  persistPbxState,
  vosCallSpansCache,
  vosCallTimestampsCache,
  type MissedNoCallbackItem,
} from "../modules/pbx/pbx.state.js";

const router = Router();
router.use("/vos", requireAuth);

// ─── Session ─────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Per-agent completed-call spans from the most recent VoSLogic refresh.
 * Keyed by lowercase agent name. Consumed by violations.ts for busy detection.
 */
export type VosCallHistoryStat = RetentionPbxCallHistoryStat;
export type VosRingGroupMissed = RetentionPbxRingGroupMissed;
export {
  getCallHistoryCache,
  vosCallSpansCache,
  vosCallTimestampsCache,
} from "../modules/pbx/pbx.state.js";
export { hydratePbxState as hydrateVosState } from "../modules/pbx/pbx.state.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Only these Quo/OpenPhone line names are team-shared lines.
// Personal agent lines (e.g. "Rick Miller RT OB", "Jenny NSF") are excluded.
const TEAM_QUO_LINES = [...OPERATIONAL_CONFIG.trackedTeamLines];

// ─── Call history — background-refreshed cache ───────────────────────────────

// Persistent line→ring group map: accumulates across refreshes within a server session.
// Once a mapping is learned (e.g. +19498210062 → ring group 4) it is never lost, so
// ring groups with no answered calls on a given day still get their missed calls counted.
const persistentLineRgMap = pbxRuntimeState.persistentLineRingGroups;
const ringGroupNameCache = pbxRuntimeState.ringGroupNames;

// Cumulative ring group missed counts — survive across refreshes within a server session.
// VoSLogic's global /api/calls endpoint doesn't paginate (always returns the same recent
// snapshot), so each refresh only sees the latest ~100 calls. By accumulating counts via
// seenMissedCallIds we build up the true daily total across all 15-minute refresh cycles.
const cumulativeRingGroupMissed = pbxRuntimeState.cumulativeRingGroupMissed;
const seenMissedCallIds = pbxRuntimeState.seenMissedCallIds;
// Per-hour PBX missed breakdown (LA timezone), keyed by hour 0–23.
const cumulativeMissedByHour = pbxRuntimeState.cumulativeMissedByHour;

export async function refreshCallHistory(
  log?: Logger,
  options: { deepBackfill?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (pbxRuntimeState.fetching) return;
  pbxRuntimeState.fetching = true;
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
          const detail = await pbxProviderService.fetchAgentCallsForDate(agentId, a.calls, today, yesterday);
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
    const quoLineNumbers = await pbxProviderService.fetchQuoLineNumbers();
    const internalNumbers = new Set<string>([
      ...[...lineToRingGroupId.keys()].map(normalizePhone),
      ...quoLineNumbers,
    ]);
    pbxRuntimeState.internalNumbers = Array.from(internalNumbers).filter(Boolean);

    const scanResult = await pbxProviderService.scanRingGroupCalls({
      lineToRingGroupId,
      ringGroupIdToName,
      totalCallsToday: dashboard.totalCallsToday ?? 600,
      agentToRingGroups,
      internalNumbers,
      persistentLineRingGroups: persistentLineRgMap,
      blocklist: await getBlockedNumbers(),
    });
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

    missedNoCB.push(...buildQuoMissedNoCallbackItems(
      quoMissed,
      callbackTimes,
      blocklist,
      internalNumbers,
    ));

    // ── Accumulate ring group missed counts across refreshes ──────────────────
    // Reset if date has changed (midnight rollover) to avoid counting yesterday's calls.
    if (pbxRuntimeState.cumulativeDate !== today) {
      pbxRuntimeState.cumulativeDate = today;
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
      const rm = await nsfReadymodeService.listActive();
      for (const it of rm) missedNoCB.push(it);
    } catch (e) {
      log?.warn({ err: e }, "readymode queue merge failed");
    }

    pbxRuntimeState.callHistory = results;
    pbxRuntimeState.fetchedAt = Date.now();
    pbxRuntimeState.ringGroupMissed = { ...cumulativeRingGroupMissed };
    pbxRuntimeState.missedNoCallback = missedNoCB;
    options.signal?.throwIfAborted();
    await persistPbxState();

    log?.info(
      {
        agents: results.length,
        ringGroupMissed: pbxRuntimeState.ringGroupMissed,
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
      const deep = await pbxProviderService.scanRingGroupCalls({
        lineToRingGroupId,
        ringGroupIdToName,
        totalCallsToday: dashboard.totalCallsToday ?? 600,
        agentToRingGroups,
        internalNumbers,
        persistentLineRingGroups: persistentLineRgMap,
        blocklist: await getBlockedNumbers(),
        maxPages: 100,
      });
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
    pbxRuntimeState.fetching = false;
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
    await hydratePbxState();
    const payload = await retentionPbxService.getStats({
      actor: req.user!,
      cache: {
        callHistory: pbxRuntimeState.callHistory,
        fetchedAt: pbxRuntimeState.fetchedAt,
        ringGroupMissed: pbxRuntimeState.ringGroupMissed,
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
  return res.json(await pbxNoCallbackService.get({ actor: req.user!, log: req.log }));
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
      internalNumbers: pbxRuntimeState.internalNumbers,
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
      internalNumbers: pbxRuntimeState.internalNumbers,
      liveRingGroupMissed: pbxRuntimeState.ringGroupMissed,
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
      internalNumbers: pbxRuntimeState.internalNumbers,
    }));
  } catch (err) {
    req.log.error(err, "vos missed-breakdown error");
    res.status(500).json({ error: "PBX historical breakdown is temporarily unavailable." });
  }
});

router.get("/vos/callback-review", async (req, res) => {
  try {
    const parsed = parsePbxCallbackReviewQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(await pbxMissedReportingService.getCallbackReview({
      actor: req.user!,
      query: parsed.value,
      internalNumbers: pbxRuntimeState.internalNumbers,
    }));
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
