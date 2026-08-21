import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "pino";
import type {
  VosAgent,
  VosDashboard,
  VosRingGroup,
} from "../../integrations/pbx/client.js";
import { createAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import type { RetentionPbxRepository } from "./retention.pbx.repository.js";
import { RetentionPbxService } from "./retention.pbx.service.js";
import type { RetentionPbxStatsCache } from "./retention.pbx.types.js";

const admin: AuthPayload = {
  userId: 1,
  username: "sanitized-admin",
  role: "admin",
  permissions: [],
};

const retentionViewer: AuthPayload = {
  userId: 202,
  username: "sanitized-retention-viewer",
  role: "view",
  permissions: ["view_metrics"],
  teamAccess: "retention",
  allowedTabs: ["retention"],
};

const agents: VosAgent[] = [
  { id: 1, name: "Agent Alpha", extension: "101", email: "", role: "agent", status: "available", ringGroupIds: [10] },
  { id: 2, name: "Agent Beta", extension: "102", email: "", role: "agent", status: "offline", ringGroupIds: [20] },
];

const ringGroups: VosRingGroup[] = [
  { id: 10, name: "Retention", agentIds: [1] },
  { id: 20, name: "CS", agentIds: [2] },
];

const dashboard: VosDashboard = {
  activeCalls: 2,
  totalAgents: 2,
  onlineAgents: 1,
  availableAgents: 1,
  totalCallsToday: 7,
  avgDurationToday: 50,
  totalInboundToday: 4,
  totalOutboundToday: 3,
  missedCallsToday: 1,
  callsByAgent: [
    { agentName: "Agent Alpha", calls: 4, inbound: 3, outbound: 1, avgDuration: 60 },
    { agentName: "Agent Beta", calls: 3, inbound: 1, outbound: 2, avgDuration: 40 },
  ],
  liveCalls: [
    { id: 1, direction: "inbound", callerNumber: "+15550000001", calledNumber: "101", phoneLabel: "Retention", ringGroupName: "Retention", agentName: "Agent Alpha", duration: 10, startedAt: "2026-08-16T11:59:50.000Z" },
    { id: 2, direction: "inbound", callerNumber: "+15550000002", calledNumber: "102", phoneLabel: "CS", ringGroupName: "CS", agentName: "Agent Beta", duration: 20, startedAt: "2026-08-16T11:59:40.000Z" },
  ],
  agentStatuses: [
    { id: 1, name: "Agent Alpha", extension: "101", status: "available", callsToday: 4 },
    { id: 2, name: "Agent Beta", extension: "102", status: "offline", callsToday: 3 },
  ],
};

const cache: RetentionPbxStatsCache = {
  callHistory: [
    { agentName: "Agent Alpha", calls: 4, inbound: 3, outbound: 1, answered: 3, missed: 1, voicemail: 0, durationSeconds: 240, lastCallAt: null, firstCallAt: null },
    { agentName: "Agent Beta", calls: 3, inbound: 1, outbound: 2, answered: 3, missed: 0, voicemail: 0, durationSeconds: 120, lastCallAt: null, firstCallAt: null },
  ],
  fetchedAt: Date.parse("2026-08-16T11:59:30.000Z"),
  ringGroupMissed: { 10: 1, 20: 2 },
};

function repository(overrides: Partial<RetentionPbxRepository> = {}): RetentionPbxRepository {
  return {
    async enqueueScheduledRefresh() {},
    async loadAuthorizationAgentDirectory() {
      return createAuthorizationAgentDirectory([
        { id: 11, name: "Agent Alpha", arabicName: null, team: "retention", active: true },
        { id: 12, name: "Agent Beta", arabicName: null, team: "cs", active: true },
      ]);
    },
    ...overrides,
  };
}

function service(repo: RetentionPbxRepository, calls: string[] = []): RetentionPbxService {
  return new RetentionPbxService({
    repository: repo,
    async fetchJson<T>(path: string): Promise<T> {
      calls.push(path);
      const value = path === "/api/agents"
        ? agents
        : path === "/api/ring-groups"
          ? ringGroups
          : dashboard;
      return value as T;
    },
    now: () => new Date("2026-08-16T12:00:00.000Z"),
  });
}

const log = { warn() {} } as unknown as Pick<Logger, "warn">;

test("PBX stats preserves stale refresh enqueue, provider fan-out, and dashboard fallback", async () => {
  const enqueued: string[] = [];
  const providerCalls: string[] = [];
  const repo = repository({
    async enqueueScheduledRefresh(minute) { enqueued.push(minute); },
    async loadAuthorizationAgentDirectory() {
      assert.fail("administrator PBX stats must not load the roster directory");
    },
  });
  const result = await service(repo, providerCalls).getStats({
    actor: admin,
    cache: { callHistory: [], fetchedAt: 0, ringGroupMissed: {} },
    log,
  });

  assert.deepEqual(enqueued, ["202608161200"]);
  assert.deepEqual(new Set(providerCalls), new Set(["/api/agents", "/api/ring-groups", "/api/dashboard"]));
  assert.equal(result.callHistory[0]?.agentName, "Agent Alpha");
  assert.equal(result.callHistory[0]?.answered, 4);
  assert.equal(result.callHistory[0]?.durationSeconds, 240);
  assert.equal(result.callHistoryFetchedAt, 0);
});

test("PBX stats scopes agents, ring groups, histories, and recomputed totals together", async () => {
  let directoryCalls = 0;
  const repo = repository();
  const originalDirectory = repo.loadAuthorizationAgentDirectory;
  repo.loadAuthorizationAgentDirectory = async () => {
    directoryCalls += 1;
    return originalDirectory();
  };
  const result = await service(repo).getStats({ actor: retentionViewer, cache, log });

  assert.deepEqual(result.agents.map(({ name }) => name), ["Agent Alpha"]);
  assert.deepEqual(result.ringGroups.map(({ id }) => id), [10]);
  assert.deepEqual(result.callHistory.map(({ agentName }) => agentName), ["Agent Alpha"]);
  assert.deepEqual(result.ringGroupMissed, { 10: 1 });
  assert.equal(result.dashboard.totalCallsToday, 4);
  assert.equal(result.dashboard.totalInboundToday, 3);
  assert.equal(result.dashboard.totalOutboundToday, 1);
  assert.equal(result.dashboard.missedCallsToday, 1);
  assert.equal(result.dashboard.avgDurationToday, 60);
  assert.equal(result.dashboard.activeCalls, 1);
  assert.equal(directoryCalls, 1);
});

test("PBX live applies roster authorization without changing provider shapes", async () => {
  let directoryCalls = 0;
  const repo = repository();
  const originalDirectory = repo.loadAuthorizationAgentDirectory;
  repo.loadAuthorizationAgentDirectory = async () => {
    directoryCalls += 1;
    return originalDirectory();
  };
  const pbx = service(repo);

  const scoped = await pbx.getLive(retentionViewer);
  const unscoped = await pbx.getLive(admin);

  assert.deepEqual(scoped.liveCalls.map(({ agentName }) => agentName), ["Agent Alpha"]);
  assert.deepEqual(scoped.agentStatuses.map(({ name }) => name), ["Agent Alpha"]);
  assert.equal(unscoped.liveCalls.length, 2);
  assert.equal(unscoped.agentStatuses.length, 2);
  assert.equal(directoryCalls, 1);
});
