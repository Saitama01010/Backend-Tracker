import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import type { RetentionQuoLiveWebhookCall } from "./retention.quo.live-state.js";
import type {
  RetentionQuoDurableEntry,
  RetentionQuoLivePollSnapshot,
  RetentionQuoLiveRepository,
} from "./retention.quo.live.repository.js";
import {
  LivePollRefreshInProgressError,
  RetentionQuoLiveService,
  type RetentionQuoLiveDependencies,
} from "./retention.quo.live.service.js";

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

function durable<T>(value: T, updatedAt: string): RetentionQuoDurableEntry<T> {
  return { value, updatedAt: new Date(updatedAt), expiresAt: null };
}

function repositoryStub(
  overrides: Partial<RetentionQuoLiveRepository> = {},
): RetentionQuoLiveRepository {
  return {
    async tryAcquirePollLease() { return true; },
    async releasePollLease() {},
    async loadFreshPollState() { return null; },
    async loadPollState() { return null; },
    async publishPollState() {},
    async loadDurableWebhookCalls() { return []; },
    async loadDurableWebhookEnds() { return []; },
    async loadWebhookObservation() { return null; },
    async loadInProgressRows() { return []; },
    async persistCompletedCalls() { return { inserted: 0, errors: 0 }; },
    async deleteDurableWebhookCall() {},
    async loadAuthorizationAgentDirectory() {
      return createAuthorizationAgentDirectory([]);
    },
    ...overrides,
  };
}

function serviceDependencies(
  repository: RetentionQuoLiveRepository,
  webhookCalls = new Map<string, RetentionQuoLiveWebhookCall>(),
): RetentionQuoLiveDependencies {
  return {
    repository,
    async fetchLiveDirectory() { return { users: [], lines: [] }; },
    async fetchRecentConversations() { return []; },
    async fetchConversationCalls() { return []; },
    buildPhoneCallRow() { throw new Error("unexpected completed call"); },
    now: () => new Date("2026-08-16T12:00:00.000Z"),
    performanceNow: (() => {
      let tick = 0;
      return () => tick++;
    })(),
    randomId: () => "sanitized-owner",
    webhookCalls,
  };
}

test("QUO live service merges fresh sources and suppresses terminally ended observations", async () => {
  const webhookCalls = new Map<string, RetentionQuoLiveWebhookCall>([["call-webhook", {
    agentName: "Agent Webhook",
    participant: "+15550000001",
    ringingSince: new Date("2026-08-16T11:59:55.000Z"),
  }]]);
  const repository = repositoryStub({
    async loadPollState() {
      return durable<RetentionQuoLivePollSnapshot>({
        active: ["Agent Poll", "Agent Ended"],
        agentCalls: [
          { agentName: "Agent Poll", participant: "+15550000002" },
          { agentName: "Agent Ended", participant: "+15550000003" },
        ],
        sourceTimestamp: "2026-08-16T11:59:40.000Z",
      }, "2026-08-16T11:59:40.000Z");
    },
    async loadDurableWebhookEnds() {
      return [durable({
        agentName: "Agent Ended",
        sourceTimestamp: "2026-08-16T11:59:50.000Z",
      }, "2026-08-16T11:59:50.000Z")];
    },
    async loadWebhookObservation() {
      return durable({ sourceTimestamp: "2026-08-16T11:59:55.000Z" }, "2026-08-16T11:59:55.000Z");
    },
    async loadInProgressRows() {
      return [{
        agentName: "Agent Database",
        participant: "+15550000004",
        syncedAt: new Date("2026-08-16T11:59:30.000Z"),
      }];
    },
    async loadAuthorizationAgentDirectory() {
      assert.fail("administrator live reads must not load the roster directory");
    },
  });
  const service = new RetentionQuoLiveService(serviceDependencies(repository, webhookCalls));

  const result = await service.getLiveStatus(admin);
  const payload = JSON.parse(result.body);

  assert.deepEqual(new Set(payload.active), new Set([
    "Agent Webhook",
    "Agent Poll",
    "Agent Database",
  ]));
  assert.equal(payload.active.includes("Agent Ended"), false);
  assert.equal(payload.webhookActive, true);
  assert.equal(payload.sourceTimestamp, "2026-08-16T11:59:55.000Z");
  assert.equal(payload.observedAt, "2026-08-16T12:00:00.000Z");
  assert.equal(payload.fresh, true);
  assert.equal(payload.stale, false);
});

test("QUO live service scopes agents and webhook activity on every non-admin read", async () => {
  let directoryCalls = 0;
  const webhookCalls = new Map<string, RetentionQuoLiveWebhookCall>([["call-cs", {
    agentName: "Agent Beta",
    participant: "+15550000002",
    ringingSince: new Date("2026-08-16T11:59:55.000Z"),
  }]]);
  const repository = repositoryStub({
    async loadPollState() {
      return durable<RetentionQuoLivePollSnapshot>({
        active: ["Agent Alpha"],
        agentCalls: [{ agentName: "Agent Alpha", participant: "+15550000001" }],
        sourceTimestamp: "2026-08-16T11:59:50.000Z",
      }, "2026-08-16T11:59:50.000Z");
    },
    async loadAuthorizationAgentDirectory() {
      directoryCalls += 1;
      return createAuthorizationAgentDirectory([
        { id: 11, name: "Agent Alpha", arabicName: null, team: "retention", active: true },
        { id: 12, name: "Agent Beta", arabicName: null, team: "cs", active: true },
      ]);
    },
  });
  const service = new RetentionQuoLiveService(serviceDependencies(repository, webhookCalls));

  const first = JSON.parse((await service.getLiveStatus(retentionViewer)).body);
  const second = JSON.parse((await service.getLiveStatus(retentionViewer)).body);

  assert.deepEqual(first.active, ["Agent Alpha"]);
  assert.deepEqual(first.agentCalls, [{ agentName: "Agent Alpha", participant: "+15550000001" }]);
  assert.equal(first.webhookActive, false);
  assert.deepEqual(second.active, first.active);
  assert.equal(directoryCalls, 2);
});

test("QUO explicit refresh reuses durable state and preserves one provider scan", async () => {
  let state: RetentionQuoDurableEntry<RetentionQuoLivePollSnapshot> | null = null;
  let leaseCalls = 0;
  let releaseCalls = 0;
  let directoryCalls = 0;
  let conversationCalls = 0;
  let callCalls = 0;
  let persistCalls = 0;
  const repository = repositoryStub({
    async tryAcquirePollLease() {
      leaseCalls += 1;
      return true;
    },
    async releasePollLease() {
      releaseCalls += 1;
    },
    async loadFreshPollState() {
      return state;
    },
    async publishPollState(_key, snapshot) {
      state = durable(snapshot, "2026-08-16T12:00:00.000Z");
    },
    async persistCompletedCalls(rows) {
      persistCalls += 1;
      assert.deepEqual(rows, []);
      return { inserted: 0, errors: 0 };
    },
  });
  const dependencies = serviceDependencies(repository);
  dependencies.fetchLiveDirectory = async () => {
    directoryCalls += 1;
    return {
      users: [{ id: "user-alpha", firstName: "Agent", lastName: "Alpha" }],
      lines: [{ id: "line-retention", name: "Retention Line", users: [] }],
    };
  };
  dependencies.fetchRecentConversations = async () => {
    conversationCalls += 1;
    return [{
      id: "conversation-live",
      phoneNumberId: "line-retention",
      participants: ["+15550000001"],
    }];
  };
  dependencies.fetchConversationCalls = async () => {
    callCalls += 1;
    return [{
      id: "call-live",
      status: "in-progress",
      direction: "incoming",
      duration: 0,
      createdAt: "2026-08-16T11:59:30.000Z",
      answeredBy: "user-alpha",
      participants: ["+15550000001"],
    }];
  };
  const service = new RetentionQuoLiveService(dependencies);

  const first = await service.requestLiveRefresh();
  const second = await service.requestLiveRefresh();

  assert.deepEqual(first.active, ["Agent Alpha"]);
  assert.deepEqual(second, first);
  assert.deepEqual({
    leaseCalls,
    releaseCalls,
    directoryCalls,
    conversationCalls,
    callCalls,
    persistCalls,
  }, {
    leaseCalls: 1,
    releaseCalls: 1,
    directoryCalls: 1,
    conversationCalls: 1,
    callCalls: 1,
    persistCalls: 1,
  });
});

test("QUO refresh reports an existing durable lease without provider work", async () => {
  const repository = repositoryStub({
    async tryAcquirePollLease() { return false; },
  });
  const service = new RetentionQuoLiveService(serviceDependencies(repository));
  await assert.rejects(
    service.requestLiveRefresh(),
    (error: unknown) => error instanceof LivePollRefreshInProgressError,
  );
});
