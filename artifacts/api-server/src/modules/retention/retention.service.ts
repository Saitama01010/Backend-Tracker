import { performance } from "node:perf_hooks";
import {
  fetchGoogleSheetValues,
  googleSheetTitleForGid,
} from "../../integrations/googleSheets/client.js";
import {
  mapGoogleSheetValues,
  type GoogleSheetData,
  type GoogleSheetMapping,
} from "../../integrations/googleSheets/mapper.js";
import { scopeSheetData } from "../../lib/authorizationScope.js";
import { isApprovedSheetSource } from "../../lib/externalIntegrationPolicy.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { retentionRepository, type RetentionRepository } from "./retention.repository.js";
import type {
  RetentionSheetCacheStatus,
  RetentionSheetQuery,
  RetentionSheetResult,
} from "./retention.types.js";

type SheetSourceSnapshot = GoogleSheetMapping & {
  fetchedAt: Date;
  providerMs: number;
};

interface LoadedSheetSnapshot {
  snapshot: SheetSourceSnapshot;
  cache: RetentionSheetCacheStatus;
  refreshError: boolean;
}

export interface RetentionServiceDependencies {
  repository: RetentionRepository;
  isApprovedSource: typeof isApprovedSheetSource;
  titleForGid: typeof googleSheetTitleForGid;
  fetchValues: typeof fetchGoogleSheetValues;
  mapValues: typeof mapGoogleSheetValues;
  now: () => Date;
  performanceNow: () => number;
}

export class RetentionSheetSourcePolicyError extends Error {}
export class RetentionSheetSourceNotApprovedError extends Error {}
export class RetentionSheetNotFoundError extends Error {}
export class RetentionSheetForbiddenError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const SHEET_CACHE_TTL_MS = 60_000;
const SHEET_MAX_STALE_MS = 5 * 60_000;

function roundedMs(value: number): number {
  return Math.round(value * 100) / 100;
}

export class RetentionService {
  private readonly sheetCache = new Map<string, SheetSourceSnapshot>();
  private readonly sheetRefreshes = new Map<string, Promise<SheetSourceSnapshot>>();

  constructor(private readonly dependencies: RetentionServiceDependencies) {}

  private async refreshSheetSnapshot(
    spreadsheetId: string,
    title: string,
  ): Promise<SheetSourceSnapshot> {
    const fetched = await this.dependencies.fetchValues(spreadsheetId, title);
    const mapped = this.dependencies.mapValues(fetched.payload);
    return {
      ...mapped,
      fetchedAt: this.dependencies.now(),
      providerMs: fetched.providerMs,
    };
  }

  private async loadSheetSnapshot(
    spreadsheetId: string,
    gid: number,
    title: string,
  ): Promise<LoadedSheetSnapshot> {
    const key = `${spreadsheetId}:${gid}`;
    const now = this.dependencies.now().getTime();
    const cached = this.sheetCache.get(key);
    if (cached && now - cached.fetchedAt.getTime() <= SHEET_CACHE_TTL_MS) {
      return { snapshot: cached, cache: "hit", refreshError: false };
    }

    let refresh = this.sheetRefreshes.get(key);
    if (!refresh) {
      refresh = this.refreshSheetSnapshot(spreadsheetId, title);
      this.sheetRefreshes.set(key, refresh);
      void refresh.finally(() => {
        if (this.sheetRefreshes.get(key) === refresh) this.sheetRefreshes.delete(key);
      }).catch(() => undefined);
    }

    try {
      const snapshot = await refresh;
      this.sheetCache.set(key, snapshot);
      return { snapshot, cache: "miss", refreshError: false };
    } catch (error) {
      if (cached && now - cached.fetchedAt.getTime() <= SHEET_MAX_STALE_MS) {
        return { snapshot: cached, cache: "stale", refreshError: true };
      }
      throw error;
    }
  }

  async getDashboardSheet(input: {
    actor: AuthPayload;
    query: RetentionSheetQuery;
  }): Promise<RetentionSheetResult> {
    const { spreadsheetId, gid, compact } = input.query;
    let approved: boolean;
    try {
      approved = this.dependencies.isApprovedSource(spreadsheetId, gid);
    } catch (error) {
      throw new RetentionSheetSourcePolicyError("Google Sheets source policy is invalid", { cause: error });
    }
    if (!approved) throw new RetentionSheetSourceNotApprovedError("Spreadsheet source is not approved");

    const title = await this.dependencies.titleForGid(spreadsheetId, gid);
    if (!title) throw new RetentionSheetNotFoundError(`gid ${gid} not found in spreadsheet`);

    const loaded = await this.loadSheetSnapshot(spreadsheetId, gid, title);
    const authorizationStartedAt = this.dependencies.performanceNow();
    const scoped = scopeSheetData(
      input.actor,
      loaded.snapshot.data,
      await this.dependencies.repository.loadAuthorizationAgentDirectory(),
    );
    const authorizationMs = roundedMs(this.dependencies.performanceNow() - authorizationStartedAt);
    if (!scoped.ok) throw new RetentionSheetForbiddenError(scoped.reason);

    const observedAt = loaded.snapshot.fetchedAt.toISOString();
    const stale = loaded.cache === "stale";
    const payload = compact ? {
      format: "rows-v1" as const,
      headers: scoped.data.headers,
      columns: loaded.snapshot.rawHeaders,
      rows: scoped.data.rows.map((row) =>
        loaded.snapshot.rawHeaders.map((_, index) => row[`__col${index}`] ?? ""),
      ),
      meta: {
        fetchedAt: observedAt,
        observedAt,
        stale,
        refreshError: loaded.refreshError,
        cache: loaded.cache,
        rowsReceived: scoped.data.rows.length,
        rowsAccepted: scoped.data.rows.length,
        rowsSkipped: 0,
      },
    } : scoped.data satisfies GoogleSheetData;

    return {
      payload,
      cache: loaded.cache,
      stale,
      refreshError: loaded.refreshError,
      fetchedAt: loaded.snapshot.fetchedAt,
      rowsReturned: scoped.data.rows.length,
      providerMs: loaded.cache === "miss" ? loaded.snapshot.providerMs : 0,
      parseMs: loaded.cache === "miss" ? loaded.snapshot.parseMs : 0,
      authorizationMs,
    };
  }
}

export const retentionService = new RetentionService({
  repository: retentionRepository,
  isApprovedSource: isApprovedSheetSource,
  titleForGid: googleSheetTitleForGid,
  fetchValues: fetchGoogleSheetValues,
  mapValues: mapGoogleSheetValues,
  now: () => new Date(),
  performanceNow: () => performance.now(),
});
