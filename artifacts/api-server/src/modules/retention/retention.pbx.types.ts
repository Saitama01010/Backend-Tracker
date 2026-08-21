export interface RetentionPbxCallHistoryStat {
  agentName: string;
  calls: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  durationSeconds: number;
  lastCallAt: string | null;
  firstCallAt: string | null;
}

export type RetentionPbxRingGroupMissed = Record<number, number>;

export interface RetentionPbxStatsCache {
  callHistory: RetentionPbxCallHistoryStat[];
  fetchedAt: number;
  ringGroupMissed: RetentionPbxRingGroupMissed;
}
