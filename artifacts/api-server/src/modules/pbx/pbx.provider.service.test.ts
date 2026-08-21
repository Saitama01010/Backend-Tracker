import assert from "node:assert/strict";
import test from "node:test";
import type { VosCallRaw } from "../../integrations/pbx/client.js";
import { PbxProviderService } from "./pbx.provider.service.js";

function call(input: Partial<VosCallRaw> & Pick<VosCallRaw, "id" | "createdAt">): VosCallRaw {
  return {
    direction: "inbound",
    status: "completed",
    duration: 60,
    agentId: 1,
    agentName: "Agent One",
    ...input,
  };
}

test("PBX provider agent pagination preserves date caps, status totals, callbacks, and busy spans", async () => {
  const paths: string[] = [];
  const pages: VosCallRaw[][] = [
    [
      call({ id: 1, createdAt: "2026-08-16T11:00:00.000Z", fromNumber: "+12025550101", toNumber: "+12025550999" }),
      call({ id: 2, createdAt: "2026-08-16T10:00:00.000Z", direction: "outbound", status: "missed", duration: null, toNumber: "+12025550102" }),
      call({ id: 3, createdAt: "2026-08-15T09:00:00.000Z", status: "voicemail", duration: 30 }),
    ],
    [call({ id: 4, createdAt: "2026-08-14T09:00:00.000Z" })],
  ];
  const service = new PbxProviderService(async <T>(path: string) => {
    paths.push(path);
    return { calls: pages[paths.length - 1] ?? [] } as T;
  }, async () => []);

  const result = await service.fetchAgentCallsForDate(7, 10, "2026-08-16", "2026-08-15");
  assert.deepEqual(paths, [
    "/api/calls?agentId=7&limit=100&page=1",
    "/api/calls?agentId=7&limit=100&page=2",
  ]);
  assert.deepEqual({
    answered: result.answered,
    missed: result.missed,
    voicemail: result.voicemail,
    durationSeconds: result.durationSeconds,
    firstCallAt: result.firstCallAt,
    lastCallAt: result.lastCallAt,
  }, {
    answered: 1,
    missed: 1,
    voicemail: 1,
    durationSeconds: 90,
    firstCallAt: "2026-08-15T09:00:00.000Z",
    lastCallAt: "2026-08-16T11:01:00.000Z",
  });
  assert.deepEqual(result.outboundCallbacks, [{ toNumber: "+12025550102", createdAt: "2026-08-16T10:00:00.000Z" }]);
  assert.deepEqual(result.inboundAnsweredFrom, [{ fromNumber: "+12025550101", createdAt: "2026-08-16T11:00:00.000Z" }]);
  assert.equal(result.callSpans.length, 2);
  assert.equal(result.callTimestamps.length, 3);
});

test("PBX refresh directory and line probe preserve provider paths and inbound filtering", async () => {
  const paths: string[] = [];
  const dashboard = { callsByAgent: [] };
  const agents = [{ id: 7 }];
  const ringGroups = [{ id: 3 }];
  const service = new PbxProviderService(async <T>(path: string) => {
    paths.push(path);
    if (path === "/api/dashboard") return dashboard as T;
    if (path === "/api/agents") return agents as T;
    if (path === "/api/ring-groups") return ringGroups as T;
    return { calls: [
      call({ id: 20, createdAt: "2026-08-16T10:00:00.000Z", direction: "inbound", toNumber: "+12025550991" }),
      call({ id: 21, createdAt: "2026-08-16T10:01:00.000Z", direction: "outbound", toNumber: "+12025550992" }),
    ] } as T;
  }, async () => []);

  assert.deepEqual(await service.fetchRefreshDirectory(), { dashboard, agents, ringGroups });
  assert.deepEqual(await service.probeAgentInboundLines(7), ["+12025550991"]);
  assert.deepEqual(paths, [
    "/api/dashboard",
    "/api/agents",
    "/api/ring-groups",
    "/api/calls?agentId=7&limit=100&page=1",
  ]);
});

test("PBX ring-group scan preserves line learning, exclusions, callback collection, and filters", async () => {
  const paths: string[] = [];
  const page = [
    call({ id: 10, createdAt: "2026-08-16T10:00:00.000Z", direction: "outbound", toNumber: "+12025550110" }),
    call({ id: 11, createdAt: "2026-08-16T10:01:00.000Z", agentId: null, status: "missed", duration: null, fromNumber: "+12025550111", toNumber: "+12025550991", ringGroupId: 1 }),
    call({ id: 12, createdAt: "2026-08-16T10:02:00.000Z", agentId: null, status: "voicemail", fromNumber: "+12025550112", toNumber: "+12025550992", ringGroupName: "MX Retention" }),
    call({ id: 13, createdAt: "2026-08-16T10:03:00.000Z", agentId: null, status: "no-answer", fromNumber: "+12025550113", toNumber: "+12025550993" }),
  ];
  const service = new PbxProviderService(async <T>(path: string) => {
    paths.push(path);
    return { calls: paths.length === 1 ? page : [] } as T;
  }, async () => ["+1 (202) 555-0199", "2025550188"]);
  const persistent = new Map([["+12025550993", 3]]);

  assert.deepEqual(await service.fetchQuoLineNumbers(), new Set(["2025550199", "2025550188"]));
  const result = await service.scanRingGroupCalls({
    lineToRingGroupId: new Map([["+12025550992", 2]]),
    ringGroupIdToName: new Map([[1, "Retention"], [2, "MX Retention"], [3, "CS Main"]]),
    totalCallsToday: 1,
    agentToRingGroups: new Map(),
    internalNumbers: new Set(["2025550113"]),
    persistentLineRingGroups: persistent,
    blocklist: new Set(["+12025550199"]),
  });

  assert.deepEqual(paths, ["/api/calls?limit=100&page=1", "/api/calls?limit=100&page=2"]);
  assert.deepEqual(result.missedCounts, { 1: 1, 2: 1, 3: 1 });
  assert.deepEqual(result.missedRecords.map(({ id }) => id), [11]);
  assert.deepEqual(result.pbxOutboundCalls, [{ toNumber: "+12025550110", createdAt: "2026-08-16T10:00:00.000Z" }]);
  assert.equal(persistent.get("+12025550991"), 1);
});
