import { getDurableRuntimeState, putDurableRuntimeState } from "../../lib/durableRuntimeState.js";
import type {
  RetentionPbxCallHistoryStat,
  RetentionPbxRingGroupMissed,
} from "../retention/retention.pbx.types.js";

export interface MissedNoCallbackItem {
  id: string | number;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "retention" | "nsf" | "cs" | "other";
  source: "pbx" | "quo" | "readymode";
  missedCallId?: string | number | null;
  normalizedCustomerNumber?: string;
  lineId?: string | null;
  callbackFound?: boolean;
  callbackId?: string | null;
  debugReason?: string;
}

type PbxSpan = { start: number; end: number };
type PbxTimestamp = { at: string; source: "pbx"; id: string };
type MissedByHour = Record<number, { retention: number; cs: number; nsf: number }>;

export interface PbxDurableSnapshot extends Record<string, unknown> {
  callHistory: RetentionPbxCallHistoryStat[];
  fetchedAt: number;
  ringGroupMissed: RetentionPbxRingGroupMissed;
  missedNoCallback: MissedNoCallbackItem[];
  ringGroupNames: Array<[number, string]>;
  internalNumbers: string[];
  lineRingGroups: Array<[string, number]>;
  seenMissedCallIds: number[];
  cumulativeDate: string;
  cumulativeMissedByHour: MissedByHour;
  callSpans: Array<[string, PbxSpan[]]>;
  callTimestamps: Array<[string, PbxTimestamp[]]>;
}

export const pbxRuntimeState = {
  callHistory: [] as RetentionPbxCallHistoryStat[],
  fetchedAt: 0,
  fetching: false,
  ringGroupMissed: {} as RetentionPbxRingGroupMissed,
  missedNoCallback: [] as MissedNoCallbackItem[],
  ringGroupNames: new Map<number, string>(),
  internalNumbers: [] as string[],
  persistentLineRingGroups: new Map<string, number>(),
  cumulativeRingGroupMissed: {} as RetentionPbxRingGroupMissed,
  seenMissedCallIds: new Set<number>(),
  cumulativeDate: "",
  cumulativeMissedByHour: {} as MissedByHour,
  callSpans: new Map<string, PbxSpan[]>(),
  callTimestamps: new Map<string, PbxTimestamp[]>(),
};

export const vosCallSpansCache = pbxRuntimeState.callSpans;
export const vosCallTimestampsCache = pbxRuntimeState.callTimestamps;

function replaceRecord<T extends object>(target: T, source: T): void {
  for (const key of Object.keys(target)) delete target[key as keyof T];
  Object.assign(target, source);
}

export function applyPbxSnapshot(snapshot: PbxDurableSnapshot): boolean {
  if (snapshot.fetchedAt <= pbxRuntimeState.fetchedAt) return false;
  pbxRuntimeState.callHistory = snapshot.callHistory ?? [];
  pbxRuntimeState.fetchedAt = snapshot.fetchedAt;
  pbxRuntimeState.ringGroupMissed = snapshot.ringGroupMissed ?? {};
  replaceRecord(pbxRuntimeState.cumulativeRingGroupMissed, snapshot.ringGroupMissed ?? {});
  pbxRuntimeState.missedNoCallback = snapshot.missedNoCallback ?? [];
  pbxRuntimeState.ringGroupNames.clear();
  for (const [id, name] of snapshot.ringGroupNames ?? []) pbxRuntimeState.ringGroupNames.set(id, name);
  pbxRuntimeState.internalNumbers = snapshot.internalNumbers ?? [];
  pbxRuntimeState.persistentLineRingGroups.clear();
  for (const [line, group] of snapshot.lineRingGroups ?? []) pbxRuntimeState.persistentLineRingGroups.set(line, group);
  pbxRuntimeState.seenMissedCallIds.clear();
  for (const id of snapshot.seenMissedCallIds ?? []) pbxRuntimeState.seenMissedCallIds.add(id);
  pbxRuntimeState.cumulativeDate = snapshot.cumulativeDate ?? "";
  replaceRecord(pbxRuntimeState.cumulativeMissedByHour, snapshot.cumulativeMissedByHour ?? {});
  pbxRuntimeState.callSpans.clear();
  for (const [agent, spans] of snapshot.callSpans ?? []) pbxRuntimeState.callSpans.set(agent, spans);
  pbxRuntimeState.callTimestamps.clear();
  for (const [agent, calls] of snapshot.callTimestamps ?? []) pbxRuntimeState.callTimestamps.set(agent, calls);
  return true;
}

export function buildPbxSnapshot(): PbxDurableSnapshot {
  return {
    callHistory: pbxRuntimeState.callHistory,
    fetchedAt: pbxRuntimeState.fetchedAt,
    ringGroupMissed: pbxRuntimeState.ringGroupMissed,
    missedNoCallback: pbxRuntimeState.missedNoCallback,
    ringGroupNames: [...pbxRuntimeState.ringGroupNames.entries()],
    internalNumbers: pbxRuntimeState.internalNumbers,
    lineRingGroups: [...pbxRuntimeState.persistentLineRingGroups.entries()],
    seenMissedCallIds: [...pbxRuntimeState.seenMissedCallIds],
    cumulativeDate: pbxRuntimeState.cumulativeDate,
    cumulativeMissedByHour: pbxRuntimeState.cumulativeMissedByHour,
    callSpans: [...pbxRuntimeState.callSpans.entries()],
    callTimestamps: [...pbxRuntimeState.callTimestamps.entries()],
  };
}

export function getCallHistoryCache(): RetentionPbxCallHistoryStat[] {
  return pbxRuntimeState.callHistory;
}

export async function hydratePbxState(): Promise<void> {
  const snapshot = await getDurableRuntimeState<PbxDurableSnapshot>("vos:call-history");
  if (snapshot) applyPbxSnapshot(snapshot.value);
}

export async function persistPbxState(): Promise<void> {
  await putDurableRuntimeState("vos:call-history", buildPbxSnapshot(), 24 * 60 * 60_000);
}
