import {
  fetchPbxJson,
  type VosCallRaw,
} from "../../integrations/pbx/client.js";
import { fetchQuoDirectoryPhoneNumbers } from "../../integrations/quo/client.js";
import type { RetentionPbxRingGroupMissed } from "../retention/retention.pbx.types.js";
import { normalizePhone } from "./pbx.phone.js";

type PbxJsonFetcher = <T>(path: string) => Promise<T>;
type QuoDirectoryFetcher = () => Promise<string[]>;

export type PbxAgentCallSummary = {
  answered: number;
  missed: number;
  voicemail: number;
  durationSeconds: number;
  lastCallAt: string | null;
  firstCallAt: string | null;
  inboundToNumbers: string[];
  outboundCallbacks: Array<{ toNumber: string; createdAt: string }>;
  inboundAnsweredFrom: Array<{ fromNumber: string; createdAt: string }>;
  callSpans: Array<{ start: number; end: number }>;
  callTimestamps: Array<{ at: string; source: "pbx"; id: string }>;
};

export type PbxRingGroupScan = {
  missedCounts: RetentionPbxRingGroupMissed;
  missedRecords: Array<{
    id: number;
    fromNumber: string;
    toNumber: string;
    createdAt: string;
    ringGroupId: number;
    ringGroupName: string;
  }>;
  pbxOutboundCalls: Array<{ toNumber: string; createdAt: string }>;
};

const excludedRingGroups = new Set(["MX Retention"]);

export class PbxProviderService {
  constructor(
    private readonly fetchJson: PbxJsonFetcher = fetchPbxJson,
    private readonly fetchQuoDirectory: QuoDirectoryFetcher = fetchQuoDirectoryPhoneNumbers,
  ) {}

  async fetchQuoLineNumbers(): Promise<Set<string>> {
    const numbers = new Set<string>();
    for (const number of await this.fetchQuoDirectory()) numbers.add(normalizePhone(number));
    return numbers;
  }

  async fetchAgentCallsForDate(
    agentId: number,
    expectedCount: number,
    today: string,
    yesterday: string,
  ): Promise<PbxAgentCallSummary> {
    let answered = 0;
    let missed = 0;
    let voicemail = 0;
    let durationSeconds = 0;
    const callSpans: PbxAgentCallSummary["callSpans"] = [];
    let lastCallAt: string | null = null;
    let firstCallAt: string | null = null;
    const inboundToNumbers: string[] = [];
    const outboundCallbacks: PbxAgentCallSummary["outboundCallbacks"] = [];
    const inboundAnsweredFrom: PbxAgentCallSummary["inboundAnsweredFrom"] = [];
    const callTimestamps: PbxAgentCallSummary["callTimestamps"] = [];
    let totalSeen = 0;
    let page = 1;

    while (page <= 20) {
      const data = await this.fetchJson<{ calls: VosCallRaw[] }>(
        `/api/calls?agentId=${agentId}&limit=100&page=${page}`,
      );
      if (!data.calls?.length) break;

      let done = false;
      for (const call of data.calls) {
        const date = call.createdAt.slice(0, 10);
        if (date > today) continue;
        if (date < yesterday) {
          done = true;
          break;
        }
        if (totalSeen >= expectedCount) {
          done = true;
          break;
        }
        totalSeen += 1;
        if (call.status === "active" || call.status === "ringing") continue;
        callTimestamps.push({ at: call.createdAt, source: "pbx", id: `pbx:${call.id}` });

        const inProgressFallbackSeconds = 3 * 3_600;
        const spanDuration = call.duration && call.duration > 0
          ? call.duration
          : call.status === "in-progress"
            ? inProgressFallbackSeconds
            : 0;
        if (spanDuration > 0) {
          const start = new Date(call.createdAt).getTime();
          callSpans.push({ start, end: start + spanDuration * 1_000 });
        }

        const callEndAt = call.duration
          ? new Date(new Date(call.createdAt).getTime() + call.duration * 1_000).toISOString()
          : call.createdAt;
        if (!lastCallAt || callEndAt > lastCallAt) lastCallAt = callEndAt;
        if (!firstCallAt || call.createdAt < firstCallAt) firstCallAt = call.createdAt;
        if (call.status === "completed") answered += 1;
        if (call.status === "no-answer" || call.status === "missed") missed += 1;
        if (call.status === "voicemail") voicemail += 1;
        if (call.duration) durationSeconds += call.duration;

        if (call.direction === "inbound" && call.toNumber && call.status === "completed") {
          inboundToNumbers.push(call.toNumber);
        }
        if (call.direction !== "inbound" && call.toNumber) {
          outboundCallbacks.push({ toNumber: call.toNumber, createdAt: call.createdAt });
        }
        if (call.direction === "inbound" && call.fromNumber && call.status === "completed") {
          inboundAnsweredFrom.push({ fromNumber: call.fromNumber, createdAt: call.createdAt });
        }
      }
      if (done) break;
      page += 1;
    }

    return {
      answered,
      missed,
      voicemail,
      durationSeconds,
      lastCallAt,
      firstCallAt,
      inboundToNumbers,
      outboundCallbacks,
      inboundAnsweredFrom,
      callSpans,
      callTimestamps,
    };
  }

  async scanRingGroupCalls(input: {
    lineToRingGroupId: Map<string, number>;
    ringGroupIdToName: Map<number, string>;
    totalCallsToday: number;
    agentToRingGroups: Map<number, number[]>;
    internalNumbers: Set<string>;
    persistentLineRingGroups: Map<string, number>;
    blocklist: Set<string>;
    maxPages?: number;
  }): Promise<PbxRingGroupScan> {
    const missedCounts: RetentionPbxRingGroupMissed = {};
    const missedRecords: PbxRingGroupScan["missedRecords"] = [];
    const pbxOutboundCalls: PbxRingGroupScan["pbxOutboundCalls"] = [];
    const seenCallIds = new Set<number>();
    const pagesToScan = input.maxPages
      ?? Math.max(10, Math.min(20, Math.ceil((input.totalCallsToday * 1.5) / 100) + 2));
    const lineMap = new Map(input.lineToRingGroupId);
    for (const [line, ringGroupId] of input.persistentLineRingGroups) {
      if (!lineMap.has(line)) lineMap.set(line, ringGroupId);
    }
    const learnLine = (line: string, ringGroupId: number) => {
      if (!lineMap.has(line)) lineMap.set(line, ringGroupId);
      if (!input.persistentLineRingGroups.has(line)) {
        input.persistentLineRingGroups.set(line, ringGroupId);
      }
    };
    const pendingMissed: VosCallRaw[] = [];

    for (let page = 1; page <= pagesToScan; page += 1) {
      const data = await this.fetchJson<{ calls: VosCallRaw[] }>(`/api/calls?limit=100&page=${page}`);
      if (!data.calls?.length) break;
      for (const call of data.calls) {
        if (call.direction !== "inbound" && call.toNumber) {
          pbxOutboundCalls.push({ toNumber: call.toNumber, createdAt: call.createdAt });
        }
        if (call.toNumber && call.ringGroupId != null && input.ringGroupIdToName.has(call.ringGroupId)) {
          learnLine(call.toNumber, call.ringGroupId);
        }
        if (call.direction === "inbound" && call.agentId != null && call.toNumber) {
          const ringGroups = input.agentToRingGroups.get(call.agentId);
          if (ringGroups?.length) learnLine(call.toNumber, ringGroups[0]!);
        }
        if (call.agentId != null) continue;
        if (call.direction !== "inbound") continue;
        if (call.status !== "voicemail" && call.status !== "no-answer" && call.status !== "missed") continue;
        if (!call.toNumber) continue;
        if (call.ringGroupId != null && input.ringGroupIdToName.has(call.ringGroupId)) {
          learnLine(call.toNumber, call.ringGroupId);
        }
        if (call.ringGroupName && !lineMap.has(call.toNumber)) {
          for (const [ringGroupId, ringGroupName] of input.ringGroupIdToName) {
            if (ringGroupName === call.ringGroupName) {
              learnLine(call.toNumber, ringGroupId);
              break;
            }
          }
        }

        const ringGroupId = lineMap.get(call.toNumber);
        if (ringGroupId === undefined) {
          pendingMissed.push(call);
          continue;
        }
        if (seenCallIds.has(call.id)) continue;
        seenCallIds.add(call.id);
        const ringGroupName = input.ringGroupIdToName.get(ringGroupId) ?? String(ringGroupId);
        missedCounts[ringGroupId] = (missedCounts[ringGroupId] ?? 0) + 1;
        if (
          call.fromNumber
          && !excludedRingGroups.has(ringGroupName)
          && !input.blocklist.has(call.fromNumber)
          && !input.internalNumbers.has(normalizePhone(call.fromNumber))
        ) {
          missedRecords.push({
            id: call.id,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            createdAt: call.createdAt,
            ringGroupId,
            ringGroupName,
          });
        }
      }
    }

    for (const call of pendingMissed) {
      if (!call.toNumber || !call.fromNumber) continue;
      if (input.blocklist.has(call.fromNumber)) continue;
      if (input.internalNumbers.has(normalizePhone(call.fromNumber))) continue;
      const ringGroupId = lineMap.get(call.toNumber);
      if (ringGroupId === undefined) continue;
      const ringGroupName = input.ringGroupIdToName.get(ringGroupId) ?? String(ringGroupId);
      if (excludedRingGroups.has(ringGroupName)) continue;
      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);
      missedCounts[ringGroupId] = (missedCounts[ringGroupId] ?? 0) + 1;
      missedRecords.push({
        id: call.id,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        createdAt: call.createdAt,
        ringGroupId,
        ringGroupName,
      });
    }

    return { missedCounts, missedRecords, pbxOutboundCalls };
  }
}

export const pbxProviderService = new PbxProviderService();
