import { getSyncState } from "../../integrations/quo/sync.js";
import { getBlockedNumbers } from "../../lib/blockedNumbers.js";
import {
  loadPhoneStatsAggregates,
  type PhoneStatsAggregationResult,
  type PhoneStatsDimension,
  type PhoneStatsDimensionRow,
} from "../../lib/phoneStatsAggregation.js";
import type { AuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import { retentionRepository } from "./retention.repository.js";
import type { RetentionQuoCallRow } from "./retention.types.js";

export interface RetentionQuoAggregationInput {
  fromDate: Date;
  toDate: Date;
  timeZone: string;
  blockedNumbers: ReadonlySet<string>;
  resolveDimension: (row: PhoneStatsDimensionRow) => PhoneStatsDimension;
}

export interface RetentionQuoSyncState {
  lastSyncedAt: Date | null;
  isSyncing: boolean;
}

export interface RetentionQuoRepository {
  loadAuthorizationAgentDirectory(): Promise<AuthorizationAgentDirectory>;
  loadBlockedNumbers(): Promise<ReadonlySet<string>>;
  loadPhoneStatsAggregates(input: RetentionQuoAggregationInput): Promise<PhoneStatsAggregationResult>;
  loadSyncState(): Promise<RetentionQuoSyncState | null>;
  loadCallBatch(fromDate: Date, toDate: Date, offset: number, limit: number): Promise<RetentionQuoCallRow[]>;
}

export const retentionQuoRepository: RetentionQuoRepository = {
  loadAuthorizationAgentDirectory: () => retentionRepository.loadAuthorizationAgentDirectory(),
  loadBlockedNumbers: () => getBlockedNumbers(),
  loadPhoneStatsAggregates: (input) => loadPhoneStatsAggregates(input),
  async loadSyncState() {
    const state = await getSyncState();
    return state
      ? { lastSyncedAt: state.lastSyncedAt, isSyncing: state.isSyncing }
      : null;
  },
  async loadCallBatch(fromDate, toDate, offset, limit) {
    const [{ db, phoneCallsTable }, { and, desc, gte, lte }] = await Promise.all([
      import("@workspace/db"),
      import("drizzle-orm"),
    ]);
    return db.select({
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
      .limit(limit)
      .offset(offset);
  },
};
