import type { GoogleSheetData } from "../../integrations/googleSheets/mapper.js";

export interface RetentionSheetQuery {
  spreadsheetId: string;
  gid: number;
  compact: boolean;
}

export type RetentionSheetCacheStatus = "hit" | "miss" | "stale";

export type RetentionCompactSheetPayload = {
  format: "rows-v1";
  headers: string[];
  columns: string[];
  rows: string[][];
  meta: {
    fetchedAt: string;
    observedAt: string;
    stale: boolean;
    refreshError: boolean;
    cache: RetentionSheetCacheStatus;
    rowsReceived: number;
    rowsAccepted: number;
    rowsSkipped: number;
  };
};

export type RetentionSheetPayload = GoogleSheetData | RetentionCompactSheetPayload;

export interface RetentionSheetResult {
  payload: RetentionSheetPayload;
  cache: RetentionSheetCacheStatus;
  stale: boolean;
  refreshError: boolean;
  fetchedAt: Date;
  rowsReturned: number;
  providerMs: number;
  parseMs: number;
  authorizationMs: number;
}

export interface RetentionReadyModeQuery {
  fromIso?: string;
  toIso?: string;
}

export interface RetentionReadyModeDayRow {
  name: string;
  iso: string;
  dialed: number;
  talkSecs: number;
}

export interface RetentionReadyModeAgentStat {
  agentName: string;
  dialed: number;
  connected: number;
  talkTimeSecs: number;
  avgTalkSecs: number;
  connectRate: number;
}

export interface RetentionReadyModeStatsResponse {
  agents: RetentionReadyModeAgentStat[];
  totals: {
    dialed: number;
    connected: number;
    talkTimeSecs: number;
    connectRate: number;
  };
  updatedAt: string;
  raw?: string;
}

export interface RetentionReadyModeStatsResult {
  response: RetentionReadyModeStatsResponse;
  cache: RetentionSheetCacheStatus;
  stale: boolean;
  rowCount: number;
  providerMs: number;
  databaseMs: number;
  parseMs: number;
  authorizationMs: number;
  transformMs: number;
}
