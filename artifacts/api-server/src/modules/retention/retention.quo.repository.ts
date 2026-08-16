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
};
