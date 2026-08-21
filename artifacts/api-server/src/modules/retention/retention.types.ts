import type { GoogleSheetData } from "../../integrations/googleSheets/mapper.js";
import type { AuthPayload } from "../../middleware/authCore.js";

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

export interface RetentionQuoStatsQuery {
  from: string;
  to: string;
}

export type RetentionQuoStatsActor = Pick<
  AuthPayload,
  | "userId"
  | "role"
  | "permissions"
  | "teamAccess"
  | "allowedTabs"
  | "allowedAgents"
  | "lockToToday"
  | "accessModel"
  | "accessRole"
  | "selfAgentId"
  | "selfAgentName"
  | "selfAgentTeam"
  | "primaryTeam"
  | "fullTeamAccess"
  | "tabGrants"
> & Pick<AuthPayload, "username">;

export interface RetentionQuoStatsPayload {
  teamStats: Record<string, Record<string, Record<string, RetentionQuoPhoneSlot>>>;
  allAgentStats: Record<string, Record<string, RetentionQuoPhoneSlot>>;
  lineInbound: Record<string, Record<string, RetentionQuoLineInboundSlot>>;
  agentLastCall: Record<string, Record<string, string>>;
  allAgentLastCall: Record<string, string>;
  totalRows: number;
  lastSyncedAt: Date | null;
  isSyncing: boolean;
}

export interface RetentionQuoPhoneSlot {
  outbound: number;
  inbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  vmBrief: number;
  totalCalls: number;
  talkSeconds: number;
  uniqueContacts: number;
}

export interface RetentionQuoLineInboundSlot {
  lineId: string;
  lineName: string;
  received: number;
  answered: number;
  missed: number;
  voicemail: number;
}

export interface RetentionQuoStatsResult {
  body: string;
  cache: "hit" | "miss" | "bypass";
  totalRows: number;
  aggregateRows: number;
  authorizationMs: number;
  databaseMs: number;
  transformMs: number;
  serializeMs: number;
}

export interface RetentionQuoCallsInput extends RetentionQuoStatsQuery {
  team?: string;
  limit: number;
  offset: number;
}

export interface RetentionQuoCallsQuery extends RetentionQuoStatsQuery {
  team?: "retention" | "nsf" | "cs" | "killers";
  limit: number;
  offset: number;
}

export interface RetentionQuoCallRow {
  id: string;
  lineTeam: string;
  lineName: string;
  agentName: string | null;
  participant: string;
  direction: string;
  status: string;
  durationSeconds: number;
  createdAt: Date;
}

export interface RetentionQuoCallsResult {
  data: RetentionQuoCallRow[];
  total: number;
}
