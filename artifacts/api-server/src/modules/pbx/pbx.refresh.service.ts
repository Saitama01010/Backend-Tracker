import type { Logger } from "pino";
import { teamFromRingGroupName } from "../../integrations/pbx/mapper.js";
import type { RetentionPbxCallHistoryStat, RetentionPbxRingGroupMissed } from "../retention/retention.pbx.types.js";
import { nsfReadymodeService } from "../nsf/nsf.readymode.service.js";
import {
  addCallback,
  buildPbxMissedNoCallbackItems,
  buildQuoMissedNoCallbackItems,
  type CallbackEntry,
} from "./pbx.no-callback.service.js";
import { normalizePhone } from "./pbx.phone.js";
import {
  pbxProviderService,
  type PbxAgentCallSummary,
  type PbxRefreshDirectory,
  type PbxRingGroupScan,
} from "./pbx.provider.service.js";
import {
  pbxRefreshRepository,
  type PbxRefreshRepository,
  type PbxRefreshMissedInsert,
} from "./pbx.refresh.repository.js";
import {
  pbxRuntimeState,
  persistPbxState,
  type MissedNoCallbackItem,
} from "./pbx.state.js";

export interface PbxRefreshProvider {
  fetchRefreshDirectory(): Promise<PbxRefreshDirectory>;
  fetchAgentCallsForDate(
    agentId: number,
    expectedCount: number,
    today: string,
    yesterday: string,
  ): Promise<PbxAgentCallSummary>;
  probeAgentInboundLines(agentId: number): Promise<string[]>;
  fetchQuoLineNumbers(): Promise<Set<string>>;
  scanRingGroupCalls(input: Parameters<typeof pbxProviderService.scanRingGroupCalls>[0]): Promise<PbxRingGroupScan>;
}

export interface PbxRefreshReadymode {
  listActive(): Promise<MissedNoCallbackItem[]>;
}

type PbxSpan = { start: number; end: number };
type PbxTimestamp = { at: string; source: "pbx"; id: string };
type MissedByHour = Record<number, { retention: number; cs: number; nsf: number }>;

export interface PbxRefreshRuntimeState {
  fetching: boolean;
  callHistory: RetentionPbxCallHistoryStat[];
  fetchedAt: number;
  ringGroupMissed: RetentionPbxRingGroupMissed;
  missedNoCallback: MissedNoCallbackItem[];
  ringGroupNames: Map<number, string>;
  internalNumbers: string[];
  persistentLineRingGroups: Map<string, number>;
  cumulativeRingGroupMissed: RetentionPbxRingGroupMissed;
  seenMissedCallIds: Set<number>;
  cumulativeDate: string;
  cumulativeMissedByHour: MissedByHour;
  callSpans: Map<string, PbxSpan[]>;
  callTimestamps: Map<string, PbxTimestamp[]>;
}

export class PbxRefreshService {
  constructor(
    private readonly provider: PbxRefreshProvider = pbxProviderService,
    private readonly repository: PbxRefreshRepository = pbxRefreshRepository,
    private readonly readymode: PbxRefreshReadymode = nsfReadymodeService,
    private readonly state: PbxRefreshRuntimeState = pbxRuntimeState,
    private readonly persistState: () => Promise<void> = persistPbxState,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueueManual(userId: number, requestedAt = this.now()): Promise<void> {
    await this.repository.enqueueManualRefresh(userId, requestedAt);
  }

  async refresh(
    log?: Logger,
    options: { deepBackfill?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.state.fetching) return;
    this.state.fetching = true;
    this.state.callSpans.clear();
    this.state.callTimestamps.clear();
    const startedAt = this.now().getTime();
    try {
      options.signal?.throwIfAborted();
      const today = this.now().toISOString().slice(0, 10);
      const yesterday = new Date(this.now().getTime() - 86_400_000).toISOString().slice(0, 10);
      const { dashboard, agents: agentList, ringGroups } = await this.provider.fetchRefreshDirectory();
      options.signal?.throwIfAborted();

      const nameToId = new Map<string, number>();
      for (const agent of agentList) nameToId.set(agent.name.trim(), agent.id);
      const agentToRingGroups = new Map<number, number[]>();
      for (const ringGroup of ringGroups) {
        for (const agentId of ringGroup.agentIds) {
          const groups = agentToRingGroups.get(agentId) ?? [];
          groups.push(ringGroup.id);
          agentToRingGroups.set(agentId, groups);
        }
      }
      const ringGroupIdToName = new Map<number, string>();
      for (const ringGroup of ringGroups) {
        ringGroupIdToName.set(ringGroup.id, ringGroup.name);
        this.state.ringGroupNames.set(ringGroup.id, ringGroup.name);
      }

      const dashboardAgents = dashboard.callsByAgent ?? [];
      const results: RetentionPbxCallHistoryStat[] = [];
      const lineRingGroupCounts = new Map<string, Map<number, number>>();
      const agentOutboundCallbacks: Array<{ toNumber: string; createdAt: string }> = [];
      const agentInboundAnswered: Array<{ fromNumber: string; createdAt: string }> = [];
      const concurrency = 5;

      for (let index = 0; index < dashboardAgents.length; index += concurrency) {
        options.signal?.throwIfAborted();
        const batch = dashboardAgents.slice(index, index + concurrency);
        const batchResults = await Promise.all(batch.map(async (agent) => {
          options.signal?.throwIfAborted();
          const agentId = nameToId.get(agent.agentName.trim());
          if (agentId === undefined) {
            return {
              agentName: agent.agentName,
              calls: agent.calls,
              inbound: agent.inbound,
              outbound: agent.outbound,
              answered: 0,
              missed: 0,
              voicemail: 0,
              durationSeconds: Math.round((agent.avgDuration ?? 0) * agent.calls),
              lastCallAt: null,
              firstCallAt: null,
              inboundToNumbers: [] as string[],
              outboundCallbacks: [] as Array<{ toNumber: string; createdAt: string }>,
              inboundAnsweredFrom: [] as Array<{ fromNumber: string; createdAt: string }>,
              callSpans: [] as PbxSpan[],
              callTimestamps: [] as PbxTimestamp[],
            };
          }
          const detail = await this.provider.fetchAgentCallsForDate(agentId, agent.calls, today, yesterday);
          const ringGroupIds = agentToRingGroups.get(agentId) ?? [];
          for (const line of detail.inboundToNumbers) {
            const counts = lineRingGroupCounts.get(line) ?? new Map<number, number>();
            for (const ringGroupId of ringGroupIds) {
              counts.set(ringGroupId, (counts.get(ringGroupId) ?? 0) + 1);
            }
            lineRingGroupCounts.set(line, counts);
          }
          return {
            agentName: agent.agentName,
            calls: agent.calls,
            inbound: agent.inbound,
            outbound: agent.outbound,
            answered: detail.answered,
            missed: detail.missed,
            voicemail: detail.voicemail,
            durationSeconds: detail.durationSeconds,
            lastCallAt: detail.lastCallAt,
            firstCallAt: detail.firstCallAt,
            inboundToNumbers: detail.inboundToNumbers,
            outboundCallbacks: detail.outboundCallbacks,
            inboundAnsweredFrom: detail.inboundAnsweredFrom,
            callSpans: detail.callSpans,
            callTimestamps: detail.callTimestamps,
          };
        }));

        for (const result of batchResults) {
          const {
            inboundToNumbers: _inboundLines,
            outboundCallbacks,
            inboundAnsweredFrom,
            callSpans,
            callTimestamps,
            ...stat
          } = result;
          results.push(stat satisfies RetentionPbxCallHistoryStat);
          agentOutboundCallbacks.push(...outboundCallbacks);
          agentInboundAnswered.push(...inboundAnsweredFrom);
          const cacheKey = result.agentName.toLowerCase();
          if (callSpans.length > 0) {
            this.state.callSpans.set(cacheKey, [...(this.state.callSpans.get(cacheKey) ?? []), ...callSpans]);
          }
          if (callTimestamps.length > 0) {
            this.state.callTimestamps.set(cacheKey, [...(this.state.callTimestamps.get(cacheKey) ?? []), ...callTimestamps]);
          }
        }
      }

      const lineToRingGroupId = new Map<string, number>();
      for (const [line, ringGroupCounts] of lineRingGroupCounts) {
        let bestRingGroup = -1;
        let bestCount = 0;
        for (const [ringGroupId, count] of ringGroupCounts) {
          if (count > bestCount) {
            bestRingGroup = ringGroupId;
            bestCount = count;
          }
        }
        if (bestRingGroup >= 0) lineToRingGroupId.set(line, bestRingGroup);
      }

      const linesAlreadyMapped = new Set(lineToRingGroupId.keys());
      const probeAgentIds = new Set<number>();
      for (const ringGroup of ringGroups) {
        for (const agentId of ringGroup.agentIds) {
          const knownLines = [...this.state.persistentLineRingGroups.entries()]
            .filter(([, ringGroupId]) => ringGroupId === ringGroup.id)
            .map(([line]) => line);
          if (knownLines.length > 0 && linesAlreadyMapped.has(knownLines[0]!)) continue;
          if (probeAgentIds.has(agentId)) continue;
          probeAgentIds.add(agentId);
        }
      }
      const agentIdToRingGroup = new Map<number, number>();
      for (const ringGroup of ringGroups) {
        for (const agentId of ringGroup.agentIds) {
          if (!agentIdToRingGroup.has(agentId)) agentIdToRingGroup.set(agentId, ringGroup.id);
        }
      }
      const probeTasks: Promise<void>[] = [];
      for (const agentId of probeAgentIds) {
        const ringGroupId = agentIdToRingGroup.get(agentId);
        if (ringGroupId == null) continue;
        probeTasks.push((async () => {
          try {
            for (const line of await this.provider.probeAgentInboundLines(agentId)) {
              if (!this.state.persistentLineRingGroups.has(line)) {
                lineToRingGroupId.set(line, ringGroupId);
                this.state.persistentLineRingGroups.set(line, ringGroupId);
              }
            }
          } catch {
            // Probe failures remain best effort.
          }
        })());
      }
      if (probeTasks.length > 0) await Promise.all(probeTasks);
      options.signal?.throwIfAborted();

      const quoLineNumbers = await this.provider.fetchQuoLineNumbers();
      const internalNumbers = new Set<string>([
        ...[...lineToRingGroupId.keys()].map(normalizePhone),
        ...quoLineNumbers,
      ]);
      this.state.internalNumbers = [...internalNumbers].filter(Boolean);
      const scanResult = await this.provider.scanRingGroupCalls({
        lineToRingGroupId,
        ringGroupIdToName,
        totalCallsToday: dashboard.totalCallsToday ?? 600,
        agentToRingGroups,
        internalNumbers,
        persistentLineRingGroups: this.state.persistentLineRingGroups,
        blocklist: await this.repository.loadBlockedNumbers(),
      });
      options.signal?.throwIfAborted();

      const callbackTimes = new Map<string, CallbackEntry[]>();
      for (const callback of agentOutboundCallbacks) {
        addCallback(callbackTimes, callback.toNumber, new Date(callback.createdAt), null, "pbx");
      }
      for (const callback of agentInboundAnswered) {
        addCallback(callbackTimes, callback.fromNumber, new Date(callback.createdAt), null, "pbx");
      }
      for (const callback of scanResult.pbxOutboundCalls) {
        addCallback(callbackTimes, callback.toNumber, new Date(callback.createdAt), null, "pbx");
      }

      const window36Hours = new Date(this.now().getTime() - 36 * 60 * 60 * 1_000);
      const { quoOutbound, quoInboundAnswered, persistedPbxMissed } =
        await this.repository.loadCallbackRows(window36Hours);
      for (const row of quoOutbound) {
        addCallback(callbackTimes, row.participant, new Date(row.createdAt), row.id, "quo-outbound");
      }
      for (const row of quoInboundAnswered) {
        addCallback(callbackTimes, row.participant, new Date(row.createdAt), row.id, "quo-inbound");
      }

      const blocklist = await this.repository.loadBlockedNumbers();
      const missedNoCallback: MissedNoCallbackItem[] = [
        ...buildPbxMissedNoCallbackItems(
          [...scanResult.missedRecords, ...persistedPbxMissed],
          callbackTimes,
          blocklist,
          internalNumbers,
        ),
      ];
      missedNoCallback.push(...buildQuoMissedNoCallbackItems(
        await this.repository.loadQuoMissed(window36Hours),
        callbackTimes,
        blocklist,
        internalNumbers,
      ));

      if (this.state.cumulativeDate !== today) {
        this.state.cumulativeDate = today;
        for (const key of Object.keys(this.state.cumulativeRingGroupMissed)) {
          delete this.state.cumulativeRingGroupMissed[Number(key)];
        }
        for (const key of Object.keys(this.state.cumulativeMissedByHour)) {
          delete this.state.cumulativeMissedByHour[Number(key)];
        }
        this.state.seenMissedCallIds.clear();
      }

      let newCount = 0;
      const toUpsert: PbxRefreshMissedInsert[] = [];
      for (const record of scanResult.missedRecords) {
        const team = teamFromRingGroupName(record.ringGroupName);
        toUpsert.push({
          id: record.id,
          fromNumber: record.fromNumber,
          toNumber: record.toNumber,
          ringGroupId: record.ringGroupId,
          ringGroupName: record.ringGroupName,
          team,
          createdAt: new Date(record.createdAt),
        });
        if (this.state.seenMissedCallIds.has(record.id)) continue;
        this.state.seenMissedCallIds.add(record.id);
        this.state.cumulativeRingGroupMissed[record.ringGroupId] =
          (this.state.cumulativeRingGroupMissed[record.ringGroupId] ?? 0) + 1;
        if (team !== "other") {
          const hour = Number.parseInt(new Date(record.createdAt).toLocaleString("en-US", {
            timeZone: "America/Los_Angeles",
            hour: "2-digit",
            hour12: false,
          }));
          this.state.cumulativeMissedByHour[hour] ??= { retention: 0, cs: 0, nsf: 0 };
          this.state.cumulativeMissedByHour[hour][team] += 1;
        }
        newCount += 1;
      }
      if (toUpsert.length > 0) {
        options.signal?.throwIfAborted();
        await this.repository.upsertMissed(toUpsert);
      }

      try {
        missedNoCallback.push(...await this.readymode.listActive());
      } catch (error) {
        log?.warn({ err: error }, "readymode queue merge failed");
      }
      this.state.callHistory = results;
      this.state.fetchedAt = this.now().getTime();
      this.state.ringGroupMissed = { ...this.state.cumulativeRingGroupMissed };
      this.state.missedNoCallback = missedNoCallback;
      options.signal?.throwIfAborted();
      await this.persistState();

      log?.info({
        agents: results.length,
        ringGroupMissed: this.state.ringGroupMissed,
        newMissedThisCycle: newCount,
        totalMissedAccumulated: this.state.seenMissedCallIds.size,
        missedNoCB: missedNoCallback.length,
        lines: lineToRingGroupId.size,
        ms: this.now().getTime() - startedAt,
        today,
      }, "vos: call history refreshed");

      if (options.deepBackfill) {
        options.signal?.throwIfAborted();
        log?.info("vos: durable PBX backfill starting (100 pages)");
        const deep = await this.provider.scanRingGroupCalls({
          lineToRingGroupId,
          ringGroupIdToName,
          totalCallsToday: dashboard.totalCallsToday ?? 600,
          agentToRingGroups,
          internalNumbers,
          persistentLineRingGroups: this.state.persistentLineRingGroups,
          blocklist: await this.repository.loadBlockedNumbers(),
          maxPages: 100,
        });
        if (deep.missedRecords.length > 0) {
          await this.repository.upsertMissed(deep.missedRecords.map((record) => ({
            id: record.id,
            fromNumber: record.fromNumber,
            toNumber: record.toNumber,
            ringGroupId: record.ringGroupId,
            ringGroupName: record.ringGroupName,
            team: teamFromRingGroupName(record.ringGroupName),
            createdAt: new Date(record.createdAt),
          })));
        }
        log?.info({ scanned: deep.missedRecords.length }, "vos: durable PBX backfill complete");
      }
    } catch (error) {
      log?.error(error, "vos: call history refresh failed");
      throw error;
    } finally {
      this.state.fetching = false;
    }
  }
}

export const pbxRefreshService = new PbxRefreshService();

export async function refreshPbxCallHistory(
  log?: Logger,
  options: { deepBackfill?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  return pbxRefreshService.refresh(log, options);
}
