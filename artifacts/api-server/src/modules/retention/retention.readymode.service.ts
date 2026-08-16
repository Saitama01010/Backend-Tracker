import { performance } from "node:perf_hooks";
import type { Logger } from "pino";
import {
  fetchConfiguredReadyModeCsv,
  loadAttachedReadyModeCsv,
} from "../../integrations/readymode/client.js";
import { parseReadymodeRows } from "../../integrations/readymode/csvParser.js";
import { canAccessMetricAgent } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { isAdministrator } from "../../middleware/authorizationCore.js";
import { retentionRepository, type RetentionRepository } from "./retention.repository.js";
import type {
  RetentionReadyModeAgentStat,
  RetentionReadyModeDayRow,
  RetentionReadyModeQuery,
  RetentionReadyModeStatsResponse,
  RetentionReadyModeStatsResult,
  RetentionSheetCacheStatus,
} from "./retention.types.js";

type ReadyModeSource = { source: string; rows: RetentionReadyModeDayRow[] };
type ReadyModeSourceSnapshot = {
  sources: ReadyModeSource[];
  fetchedAt: Date;
  providerMs: number;
  databaseMs: number;
  parseMs: number;
  refreshError: boolean;
};

interface LoadedReadyModeSources {
  snapshot: ReadyModeSourceSnapshot;
  cache: RetentionSheetCacheStatus;
  refreshError: boolean;
}

export interface RetentionReadyModeDependencies {
  repository: RetentionRepository;
  loadAttachedCsv: typeof loadAttachedReadyModeCsv;
  fetchConfiguredCsv: typeof fetchConfiguredReadyModeCsv;
  parseRows: typeof parseReadymodeRows;
  now: () => Date;
  performanceNow: () => number;
}

const READYMODE_CACHE_TTL_MS = 60_000;
const READYMODE_MAX_STALE_MS = 5 * 60_000;
const READYMODE_CACHE_MAX_ENTRIES = 50;

function roundedTiming(value: number): number {
  return Math.round(value * 100) / 100;
}

export class RetentionReadyModeService {
  private readonly sourceCache = new Map<string, ReadyModeSourceSnapshot>();
  private readonly sourceRefreshes = new Map<string, Promise<ReadyModeSourceSnapshot>>();
  private cacheGeneration = 0;

  constructor(private readonly dependencies: RetentionReadyModeDependencies) {}

  invalidateCache(): void {
    this.cacheGeneration += 1;
    this.sourceCache.clear();
    this.sourceRefreshes.clear();
  }

  private sourceKey(fromIso?: string, toIso?: string): string {
    return `${fromIso ?? "all"}:${toIso ?? "all"}`;
  }

  private async refreshSources(
    fromIso: string | undefined,
    toIso: string | undefined,
    log: Logger,
  ): Promise<ReadyModeSourceSnapshot> {
    const sources: ReadyModeSource[] = [];
    let parseMs = 0;
    let refreshError = false;
    const ingest = (text: string, source: string) => {
      const parseStartedAt = this.dependencies.performanceNow();
      const rows = this.dependencies.parseRows(text, log, source);
      parseMs += this.dependencies.performanceNow() - parseStartedAt;
      sources.push({ source, rows });
    };

    const sourceStartedAt = this.dependencies.performanceNow();
    const attachedCsv = await this.dependencies.loadAttachedCsv();
    if (attachedCsv) ingest(attachedCsv.text, attachedCsv.source);
    try {
      const csvResponse = await this.dependencies.fetchConfiguredCsv();
      if (csvResponse.ok) {
        const text = await csvResponse.text();
        if (text.trim()) ingest(text, "google-sheet");
      } else {
        refreshError = true;
        log.warn({ status: csvResponse.status }, "readymode google sheet fetch failed");
      }
    } catch (error) {
      refreshError = true;
      log.warn({ err: error }, "readymode google sheet fetch threw");
    }
    const providerMs = roundedTiming(this.dependencies.performanceNow() - sourceStartedAt);

    const databaseStartedAt = this.dependencies.performanceNow();
    try {
      const rows = await this.dependencies.repository.loadReadyModeUploads(fromIso, toIso);
      if (rows.length) sources.push({ source: "db-upload", rows });
    } catch (error) {
      refreshError = true;
      log.warn({ err: error }, "readymode db uploads query threw");
    }

    return {
      sources,
      fetchedAt: this.dependencies.now(),
      providerMs,
      databaseMs: roundedTiming(this.dependencies.performanceNow() - databaseStartedAt),
      parseMs: roundedTiming(parseMs),
      refreshError,
    };
  }

  private async loadSources(
    fromIso: string | undefined,
    toIso: string | undefined,
    log: Logger,
  ): Promise<LoadedReadyModeSources> {
    const key = this.sourceKey(fromIso, toIso);
    const cacheGeneration = this.cacheGeneration;
    const now = this.dependencies.now().getTime();
    const cached = this.sourceCache.get(key);
    if (cached && now - cached.fetchedAt.getTime() <= READYMODE_CACHE_TTL_MS) {
      return {
        snapshot: cached,
        cache: cached.refreshError ? "stale" : "hit",
        refreshError: cached.refreshError,
      };
    }

    let refresh = this.sourceRefreshes.get(key);
    if (!refresh) {
      refresh = this.refreshSources(fromIso, toIso, log);
      this.sourceRefreshes.set(key, refresh);
      void refresh.finally(() => {
        if (this.sourceRefreshes.get(key) === refresh) this.sourceRefreshes.delete(key);
      }).catch(() => undefined);
    }
    const snapshot = await refresh;
    if (snapshot.refreshError && cached && now - cached.fetchedAt.getTime() <= READYMODE_MAX_STALE_MS) {
      return { snapshot: cached, cache: "stale", refreshError: true };
    }
    for (const [candidate, value] of this.sourceCache) {
      if (now - value.fetchedAt.getTime() > READYMODE_MAX_STALE_MS) this.sourceCache.delete(candidate);
    }
    if (this.sourceCache.size >= READYMODE_CACHE_MAX_ENTRIES) {
      const oldest = this.sourceCache.keys().next().value as string | undefined;
      if (oldest) this.sourceCache.delete(oldest);
    }
    if (cacheGeneration === this.cacheGeneration) this.sourceCache.set(key, snapshot);
    return {
      snapshot,
      cache: snapshot.refreshError ? "stale" : "miss",
      refreshError: snapshot.refreshError,
    };
  }

  async getStats(input: {
    actor: AuthPayload;
    query: RetentionReadyModeQuery;
    log: Logger;
  }): Promise<RetentionReadyModeStatsResult> {
    const { fromIso, toIso } = input.query;
    const loaded = await this.loadSources(fromIso, toIso, input.log);
    const transformStartedAt = this.dependencies.performanceNow();
    const sources = loaded.snapshot.sources;
    if (sources.length === 0) {
      const response: RetentionReadyModeStatsResponse = {
        agents: [],
        totals: { dialed: 0, connected: 0, talkTimeSecs: 0, connectRate: 0 },
        updatedAt: loaded.snapshot.fetchedAt.toISOString(),
        raw: "ReadyMode CSV unavailable — publish the Google Sheet (File → Share → Anyone with link → Viewer) or drop Agent_report_*.csv into attached_assets/.",
      };
      return this.result(loaded, response, 0, 0, transformStartedAt);
    }

    const byKey = new Map<string, RetentionReadyModeDayRow>();
    for (const { rows } of sources) {
      for (const row of rows) {
        byKey.set(`${row.name.trim().toLowerCase().replace(/\s+/g, " ")}|${row.iso}`, row);
      }
    }

    type Aggregate = { dialed: number; talkTimeSecs: number; days: Set<string> };
    const aggregate = new Map<string, Aggregate>();
    let included = 0;
    let skipped = 0;
    for (const row of byKey.values()) {
      if (fromIso && row.iso < fromIso) { skipped += 1; continue; }
      if (toIso && row.iso > toIso) { skipped += 1; continue; }
      const value = aggregate.get(row.name) ?? { dialed: 0, talkTimeSecs: 0, days: new Set<string>() };
      value.dialed += row.dialed;
      value.talkTimeSecs += row.talkSecs;
      value.days.add(row.iso);
      aggregate.set(row.name, value);
      included += 1;
    }

    const allAgents: RetentionReadyModeAgentStat[] = [...aggregate.entries()]
      .filter(([, value]) => value.dialed > 0 || value.talkTimeSecs > 0)
      .map(([agentName, value]) => ({
        agentName,
        dialed: value.dialed,
        connected: value.dialed,
        talkTimeSecs: value.talkTimeSecs,
        avgTalkSecs: value.dialed > 0 ? Math.round(value.talkTimeSecs / value.dialed) : 0,
        connectRate: 100,
      }));
    const authorizationStartedAt = this.dependencies.performanceNow();
    const directory = isAdministrator(input.actor)
      ? null
      : await this.dependencies.repository.loadAuthorizationAgentDirectory();
    const agents = directory
      ? allAgents.filter((agent) => canAccessMetricAgent(input.actor, agent.agentName, directory))
      : allAgents;
    const authorizationMs = roundedTiming(this.dependencies.performanceNow() - authorizationStartedAt);

    const totals = {
      dialed: agents.reduce((sum, agent) => sum + agent.dialed, 0),
      connected: agents.reduce((sum, agent) => sum + agent.connected, 0),
      talkTimeSecs: agents.reduce((sum, agent) => sum + agent.talkTimeSecs, 0),
      connectRate: 100,
    };
    const sourceSummary = sources.map((source) => `${source.source}(${source.rows.length})`).join(" + ");
    input.log.info(
      { included, skipped, agents: agents.length, fromIso, toIso, sources: sourceSummary },
      "readymode/stats merged",
    );
    const response: RetentionReadyModeStatsResponse = {
      agents,
      totals,
      updatedAt: loaded.snapshot.fetchedAt.toISOString(),
      raw: directory
        ? `Scoped to ${agents.length} authorized agent(s) · ${included} rows in requested range`
        : `Sources: ${sourceSummary} → ${byKey.size} unique (agent,day) rows · ${included} in range · ${skipped} out of range`,
    };
    return this.result(loaded, response, agents.length, authorizationMs, transformStartedAt);
  }

  private result(
    loaded: LoadedReadyModeSources,
    response: RetentionReadyModeStatsResponse,
    rowCount: number,
    authorizationMs: number,
    transformStartedAt: number,
  ): RetentionReadyModeStatsResult {
    return {
      response,
      cache: loaded.cache,
      stale: loaded.cache === "stale",
      rowCount,
      providerMs: loaded.cache === "miss" ? loaded.snapshot.providerMs : 0,
      databaseMs: loaded.cache === "miss" ? loaded.snapshot.databaseMs : 0,
      parseMs: loaded.cache === "miss" ? loaded.snapshot.parseMs : 0,
      authorizationMs,
      transformMs: roundedTiming(this.dependencies.performanceNow() - transformStartedAt),
    };
  }
}

export const retentionReadyModeService = new RetentionReadyModeService({
  repository: retentionRepository,
  loadAttachedCsv: loadAttachedReadyModeCsv,
  fetchConfiguredCsv: fetchConfiguredReadyModeCsv,
  parseRows: parseReadymodeRows,
  now: () => new Date(),
  performanceNow: () => performance.now(),
});
