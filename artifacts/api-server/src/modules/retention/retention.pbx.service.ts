import type { Logger } from "pino";
import {
  fetchPbxJson,
  type VosAgent,
  type VosDashboard,
  type VosRingGroup,
} from "../../integrations/pbx/client.js";
import {
  canAccessLiveAgent,
  canAccessMetricAgent,
} from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { isAdministrator } from "../../middleware/authorizationCore.js";
import {
  retentionPbxRepository,
  type RetentionPbxRepository,
} from "./retention.pbx.repository.js";
import type {
  RetentionPbxCallHistoryStat,
  RetentionPbxStatsCache,
} from "./retention.pbx.types.js";

export interface RetentionPbxDependencies {
  repository: RetentionPbxRepository;
  fetchJson: typeof fetchPbxJson;
  now: () => Date;
}

export class RetentionPbxService {
  constructor(private readonly dependencies: RetentionPbxDependencies) {}

  async getStats(input: {
    actor: AuthPayload;
    cache: RetentionPbxStatsCache;
    log: Pick<Logger, "warn">;
  }) {
    const { actor, cache, log } = input;
    const now = this.dependencies.now();
    const cacheAgeMs = cache.fetchedAt ? now.getTime() - cache.fetchedAt : Number.POSITIVE_INFINITY;
    if (!cache.callHistory.length || cacheAgeMs > 2 * 60 * 1000) {
      const minute = now.toISOString().slice(0, 16).replace(/[-T:]/g, "");
      await this.dependencies.repository.enqueueScheduledRefresh(minute)
        .catch((error) => log.warn(error, "PBX refresh enqueue failed"));
    }

    const [agents, ringGroups, dashboard] = await Promise.all([
      this.dependencies.fetchJson<VosAgent[]>("/api/agents"),
      this.dependencies.fetchJson<VosRingGroup[]>("/api/ring-groups"),
      this.dependencies.fetchJson<VosDashboard>("/api/dashboard"),
    ]);
    const callHistory: RetentionPbxCallHistoryStat[] = cache.callHistory.length > 0
      ? cache.callHistory
      : (dashboard.callsByAgent ?? []).map((agent) => ({
          agentName: agent.agentName,
          calls: agent.calls,
          inbound: agent.inbound,
          outbound: agent.outbound,
          answered: agent.calls,
          missed: 0,
          voicemail: 0,
          durationSeconds: Math.round((agent.avgDuration ?? 0) * agent.calls),
          lastCallAt: null,
          firstCallAt: null,
        }));

    if (isAdministrator(actor)) {
      return {
        dashboard,
        agents,
        ringGroups,
        callHistory,
        callHistoryFetchedAt: cache.fetchedAt,
        ringGroupMissed: cache.ringGroupMissed,
      };
    }

    const directory = await this.dependencies.repository.loadAuthorizationAgentDirectory();
    const scopedAgents = agents
      .filter((agent) => canAccessMetricAgent(actor, agent.name, directory));
    const allowedIds = new Set(scopedAgents.map((agent) => agent.id));
    const scopedHistory = callHistory
      .filter((agent) => canAccessMetricAgent(actor, agent.agentName, directory));
    const scopedCallsByAgent = (dashboard.callsByAgent ?? [])
      .filter((agent) => canAccessMetricAgent(actor, agent.agentName, directory));
    const scopedLiveCalls = (dashboard.liveCalls ?? [])
      .filter((call) => !!call.agentName && canAccessMetricAgent(actor, call.agentName, directory));
    const scopedStatuses = (dashboard.agentStatuses ?? [])
      .filter((agent) => canAccessMetricAgent(actor, agent.name, directory));
    const scopedRingGroups = ringGroups
      .map((group) => ({
        ...group,
        agentIds: group.agentIds.filter((id) => allowedIds.has(id)),
      }))
      .filter((group) => group.agentIds.length > 0);
    const allowedRingGroupIds = new Set(scopedRingGroups.map((group) => group.id));
    const scopedRingGroupMissed = Object.fromEntries(
      Object.entries(cache.ringGroupMissed)
        .filter(([id]) => allowedRingGroupIds.has(Number(id))),
    );
    const totalCalls = scopedHistory.reduce((sum, agent) => sum + agent.calls, 0);
    const totalDuration = scopedHistory
      .reduce((sum, agent) => sum + agent.durationSeconds, 0);
    const scopedDashboard: VosDashboard = {
      ...dashboard,
      activeCalls: scopedLiveCalls.length,
      totalAgents: scopedAgents.length,
      onlineAgents: scopedStatuses.filter((agent) => agent.status !== "offline").length,
      availableAgents: scopedStatuses.filter((agent) => agent.status === "available").length,
      totalCallsToday: totalCalls,
      avgDurationToday: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
      totalInboundToday: scopedHistory.reduce((sum, agent) => sum + agent.inbound, 0),
      totalOutboundToday: scopedHistory.reduce((sum, agent) => sum + agent.outbound, 0),
      missedCallsToday: scopedHistory.reduce((sum, agent) => sum + agent.missed, 0),
      callsByAgent: scopedCallsByAgent,
      liveCalls: scopedLiveCalls,
      agentStatuses: scopedStatuses,
    };
    return {
      dashboard: scopedDashboard,
      agents: scopedAgents,
      ringGroups: scopedRingGroups,
      callHistory: scopedHistory,
      callHistoryFetchedAt: cache.fetchedAt,
      ringGroupMissed: scopedRingGroupMissed,
    };
  }

  async getLive(actor: AuthPayload) {
    const dashboard = await this.dependencies.fetchJson<VosDashboard>("/api/dashboard");
    if (isAdministrator(actor)) {
      return {
        liveCalls: dashboard.liveCalls ?? [],
        agentStatuses: dashboard.agentStatuses ?? [],
      };
    }
    const directory = await this.dependencies.repository.loadAuthorizationAgentDirectory();
    return {
      liveCalls: (dashboard.liveCalls ?? [])
        .filter((call) => !!call.agentName && canAccessLiveAgent(actor, call.agentName, directory)),
      agentStatuses: (dashboard.agentStatuses ?? [])
        .filter((agent) => canAccessLiveAgent(actor, agent.name, directory)),
    };
  }
}

export const retentionPbxService = new RetentionPbxService({
  repository: retentionPbxRepository,
  fetchJson: fetchPbxJson,
  now: () => new Date(),
});
