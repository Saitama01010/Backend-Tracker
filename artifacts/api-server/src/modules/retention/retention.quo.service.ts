import { performance } from "node:perf_hooks";
import { canonicalAgentName } from "../../integrations/quo/sync.js";
import {
  dashboardAgentTeam,
  inferDashboardAgentFromLine,
} from "../../integrations/quo/dashboardMapper.js";
import { businessDayWindow } from "../../lib/businessTime.js";
import { canAccessMetricAgent } from "../../lib/authorizationScope.js";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import { isAdministrator, type MetricTeam } from "../../middleware/authorizationCore.js";
import {
  retentionQuoRepository,
  type RetentionQuoRepository,
} from "./retention.quo.repository.js";
import type {
  RetentionQuoLineInboundSlot,
  RetentionQuoPhoneSlot,
  RetentionQuoStatsActor,
  RetentionQuoStatsPayload,
  RetentionQuoStatsQuery,
  RetentionQuoStatsResult,
} from "./retention.types.js";

const PHONE_STATS_CACHE_TTL_MS = 15_000;
const PHONE_STATS_CACHE_MAX_ENTRIES = 50;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type CachedQuoStats = {
  body: string;
  createdAt: number;
  totalRows: number;
  aggregateRows: number;
};

export interface RetentionQuoStatsDependencies {
  repository: RetentionQuoRepository;
  now: () => number;
  performanceNow: () => number;
}

function roundedTiming(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseDateRange(query: RetentionQuoStatsQuery): { fromDate: Date; toDate: Date } {
  const fromDate = DATE_ONLY.test(query.from)
    ? businessDayWindow(query.from).start
    : new Date(query.from);
  const toDate = DATE_ONLY.test(query.to)
    ? businessDayWindow(query.to).endExclusive
    : new Date(query.to);
  return { fromDate, toDate };
}

function phoneStatsCacheKey(
  actor: RetentionQuoStatsActor,
  query: RetentionQuoStatsQuery,
): string {
  return JSON.stringify({
    from: query.from,
    to: query.to,
    userId: actor.userId,
    role: actor.role,
    teamAccess: actor.teamAccess ?? null,
    allowedTabs: actor.allowedTabs ?? null,
    allowedAgents: actor.allowedAgents ?? null,
    lockToToday: actor.lockToToday ?? false,
  });
}

export class RetentionQuoStatsService {
  private readonly responseCache = new Map<string, CachedQuoStats>();

  constructor(private readonly dependencies: RetentionQuoStatsDependencies) {}

  async getStats(input: {
    actor: RetentionQuoStatsActor;
    query: RetentionQuoStatsQuery;
  }): Promise<RetentionQuoStatsResult> {
    const { actor, query } = input;
    const cacheKey = isAdministrator(actor) ? phoneStatsCacheKey(actor, query) : null;
    const cached = cacheKey ? this.responseCache.get(cacheKey) : undefined;
    if (cached && this.dependencies.now() - cached.createdAt <= PHONE_STATS_CACHE_TTL_MS) {
      return {
        body: cached.body,
        cache: "hit",
        totalRows: cached.totalRows,
        aggregateRows: cached.aggregateRows,
        authorizationMs: 0,
        databaseMs: 0,
        transformMs: 0,
        serializeMs: 0,
      };
    }
    if (cached && cacheKey) this.responseCache.delete(cacheKey);

    const authorizationStartedAt = this.dependencies.performanceNow();
    const [directory, blocklist] = await Promise.all([
      isAdministrator(actor)
        ? Promise.resolve(null)
        : this.dependencies.repository.loadAuthorizationAgentDirectory(),
      this.dependencies.repository.loadBlockedNumbers(),
    ]);
    const authorizationMs = roundedTiming(
      this.dependencies.performanceNow() - authorizationStartedAt,
    );
    const { fromDate, toDate } = parseDateRange(query);

    const aggregation = await this.dependencies.repository.loadPhoneStatsAggregates({
      fromDate,
      toDate,
      timeZone: OPERATIONAL_CONFIG.businessTimeZone,
      blockedNumbers: blocklist,
      resolveDimension: (row) => {
        const agentName = canonicalAgentName(row.rawAgentName)
          ?? inferDashboardAgentFromLine(row.lineName)
          ?? "Unknown";
        const rawTeam = dashboardAgentTeam(agentName) ?? row.lineTeam;
        const fallbackTeam: MetricTeam | null = rawTeam === "retention"
          || rawTeam === "nsf"
          || rawTeam === "cs"
          ? rawTeam
          : null;
        return {
          agentName,
          team: fallbackTeam ?? "other",
          authorized: directory
            ? canAccessMetricAgent(actor, agentName, directory, fallbackTeam)
            : true,
        };
      },
    });

    const syncStartedAt = this.dependencies.performanceNow();
    const syncState = await this.dependencies.repository.loadSyncState();
    const syncQueryMs = roundedTiming(this.dependencies.performanceNow() - syncStartedAt);
    const databaseMs = roundedTiming(aggregation.timings.databaseMs + syncQueryMs);

    const transformStartedAt = this.dependencies.performanceNow();
    const teamStats: Record<string, Record<string, Record<string, RetentionQuoPhoneSlot>>> = {
      retention: {}, nsf: {}, cs: {}, other: {},
    };
    const allAgentStats: Record<string, Record<string, RetentionQuoPhoneSlot>> = {};
    const lineInbound: Record<string, Record<string, RetentionQuoLineInboundSlot>> = {};
    const agentLastCall: Record<string, Record<string, string>> = {};
    const allAgentLastCall: Record<string, string> = {};
    let totalRows = 0;

    for (const row of aggregation.rows) {
      if (row.kind === "meta") {
        totalRows = row.totalCalls;
        continue;
      }
      if (row.kind === "line") {
        if (!row.lineId || !row.lineName || !row.day) continue;
        if (!lineInbound[row.lineId]) lineInbound[row.lineId] = {};
        lineInbound[row.lineId][row.day] = {
          lineId: row.lineId,
          lineName: row.lineName,
          received: row.totalCalls,
          answered: row.answered,
          missed: row.missed,
          voicemail: row.voicemail,
        };
        continue;
      }
      if (!row.agentName || !row.day) continue;
      const slot: RetentionQuoPhoneSlot = {
        outbound: row.outbound,
        inbound: row.inbound,
        answered: row.answered,
        missed: row.missed,
        voicemail: row.voicemail,
        vmBrief: row.vmBrief,
        totalCalls: row.totalCalls,
        talkSeconds: row.talkSeconds,
        uniqueContacts: row.uniqueContacts,
      };
      if (row.kind === "team") {
        const team = row.resolvedTeam ?? "other";
        if (!teamStats[team]) teamStats[team] = {};
        if (!teamStats[team][row.agentName]) teamStats[team][row.agentName] = {};
        teamStats[team][row.agentName][row.day] = slot;
        if (row.lastCall) {
          if (!agentLastCall[team]) agentLastCall[team] = {};
          const previous = agentLastCall[team][row.agentName];
          if (!previous || row.lastCall.getTime() > Date.parse(previous)) {
            agentLastCall[team][row.agentName] = row.lastCall.toISOString();
          }
        }
      } else {
        if (!allAgentStats[row.agentName]) allAgentStats[row.agentName] = {};
        allAgentStats[row.agentName][row.day] = slot;
        if (row.lastCall) {
          const previous = allAgentLastCall[row.agentName];
          if (!previous || row.lastCall.getTime() > Date.parse(previous)) {
            allAgentLastCall[row.agentName] = row.lastCall.toISOString();
          }
        }
      }
    }

    const payload: RetentionQuoStatsPayload = {
      teamStats,
      allAgentStats,
      lineInbound,
      agentLastCall,
      allAgentLastCall,
      totalRows,
      lastSyncedAt: syncState?.lastSyncedAt ?? null,
      isSyncing: syncState?.isSyncing ?? false,
    };
    const transformMs = roundedTiming(this.dependencies.performanceNow() - transformStartedAt);
    const serializeStartedAt = this.dependencies.performanceNow();
    const body = JSON.stringify(payload);
    const serializeMs = roundedTiming(this.dependencies.performanceNow() - serializeStartedAt);

    if (cacheKey) {
      this.putCache(cacheKey, {
        body,
        totalRows,
        aggregateRows: aggregation.rows.length,
      });
    }

    return {
      body,
      cache: cacheKey ? "miss" : "bypass",
      totalRows,
      aggregateRows: aggregation.rows.length,
      authorizationMs,
      databaseMs,
      transformMs,
      serializeMs,
    };
  }

  private putCache(
    key: string,
    value: Omit<CachedQuoStats, "createdAt">,
  ): void {
    const now = this.dependencies.now();
    for (const [candidate, entry] of this.responseCache) {
      if (now - entry.createdAt > PHONE_STATS_CACHE_TTL_MS) {
        this.responseCache.delete(candidate);
      }
    }
    if (this.responseCache.size >= PHONE_STATS_CACHE_MAX_ENTRIES) {
      const oldest = this.responseCache.keys().next().value as string | undefined;
      if (oldest) this.responseCache.delete(oldest);
    }
    this.responseCache.set(key, { ...value, createdAt: now });
  }
}

export const retentionQuoStatsService = new RetentionQuoStatsService({
  repository: retentionQuoRepository,
  now: Date.now,
  performanceNow: performance.now.bind(performance),
});
