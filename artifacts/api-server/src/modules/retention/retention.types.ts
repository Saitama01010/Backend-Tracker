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
