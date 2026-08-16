import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "pino";
import { createAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { RetentionReadyModeService } from "./retention.readymode.service.js";
import {
  retentionReadyModeDateInput,
  validateRetentionReadyModeQuery,
} from "./retention.schemas.js";
import type { RetentionReadyModeDependencies } from "./retention.readymode.service.js";

const actor: AuthPayload = {
  userId: 201,
  username: "sanitized-retention-user",
  role: "view",
  permissions: ["view_metrics"],
  teamAccess: "retention",
  allowedTabs: ["retention"],
};

const log = {
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

test("ReadyMode date validation preserves authorization inputs and compatibility errors", () => {
  assert.deepEqual(retentionReadyModeDateInput({ from: ["2026-08-16"], to: 2 }), {
    fromIso: undefined,
    toIso: undefined,
  });
  assert.deepEqual(validateRetentionReadyModeQuery({ fromIso: "2026-08-16" }), {
    ok: false,
    error: "Both from and to are required.",
  });
  assert.equal(validateRetentionReadyModeQuery({ fromIso: "2026-08-16", toIso: "2026-08-16" }).ok, true);
});

test("ReadyMode service preserves source priority, authorization scope, and cache call counts", async () => {
  let attachedCalls = 0;
  let configuredCalls = 0;
  let databaseCalls = 0;
  const dependencies: RetentionReadyModeDependencies = {
    repository: {
      async loadAuthorizationAgentDirectory() {
        return createAuthorizationAgentDirectory([
          { id: 11, name: "Agent Alpha", arabicName: null, team: "retention", active: true },
          { id: 12, name: "Agent Beta", arabicName: null, team: "cs", active: true },
        ]);
      },
      async loadReadyModeUploads() {
        databaseCalls += 1;
        return [{ name: "Agent Alpha", iso: "2026-08-16", dialed: 7, talkSecs: 70 }];
      },
    },
    async loadAttachedCsv() {
      attachedCalls += 1;
      return { text: "attached", source: "attached-file" };
    },
    async fetchConfiguredCsv() {
      configuredCalls += 1;
      return new Response("configured", { status: 200 });
    },
    parseRows(text) {
      return text === "attached"
        ? [{ name: "Agent Alpha", iso: "2026-08-16", dialed: 1, talkSecs: 10 }]
        : [
            { name: "Agent Alpha", iso: "2026-08-16", dialed: 5, talkSecs: 50 },
            { name: "Agent Beta", iso: "2026-08-16", dialed: 3, talkSecs: 30 },
          ];
    },
    now: () => new Date("2026-08-16T12:00:00.000Z"),
    performanceNow: (() => {
      let tick = 0;
      return () => tick++;
    })(),
  };
  const service = new RetentionReadyModeService(dependencies);
  const input = {
    actor,
    query: { fromIso: "2026-08-16", toIso: "2026-08-16" },
    log,
  };

  const first = await service.getStats(input);
  const second = await service.getStats(input);

  assert.deepEqual(first.response.agents, [{
    agentName: "Agent Alpha",
    dialed: 7,
    connected: 7,
    talkTimeSecs: 70,
    avgTalkSecs: 10,
    connectRate: 100,
  }]);
  assert.deepEqual(first.response.totals, {
    dialed: 7,
    connected: 7,
    talkTimeSecs: 70,
    connectRate: 100,
  });
  assert.equal(second.cache, "hit");
  assert.deepEqual({ attachedCalls, configuredCalls, databaseCalls }, {
    attachedCalls: 1,
    configuredCalls: 1,
    databaseCalls: 1,
  });

  service.invalidateCache();
  await service.getStats(input);
  assert.deepEqual({ attachedCalls, configuredCalls, databaseCalls }, {
    attachedCalls: 2,
    configuredCalls: 2,
    databaseCalls: 2,
  });
});
