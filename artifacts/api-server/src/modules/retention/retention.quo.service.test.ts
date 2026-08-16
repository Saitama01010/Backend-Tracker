import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { PhoneStatsAggregateRow } from "../../lib/phoneStatsAggregation.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import type {
  RetentionQuoAggregationInput,
  RetentionQuoRepository,
} from "./retention.quo.repository.js";
import { RetentionQuoStatsService } from "./retention.quo.service.js";
import {
  retentionQuoStatsDateInput,
  validateRetentionQuoStatsQuery,
} from "./retention.schemas.js";

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

function aggregateRow(
  overrides: Partial<PhoneStatsAggregateRow>,
): PhoneStatsAggregateRow {
  return {
    kind: "team",
    resolvedTeam: "retention",
    agentName: "Agent Alpha",
    day: "2026-08-16",
    lineId: null,
    lineName: null,
    totalCalls: 3,
    outbound: 2,
    inbound: 1,
    answered: 2,
    missed: 1,
    voicemail: 0,
    vmBrief: 0,
    talkSeconds: 180,
    uniqueContacts: 2,
    lastCall: new Date("2026-08-16T18:00:00.000Z"),
    ...overrides,
  };
}

test("QUO stats validation preserves compatibility defaults and errors", () => {
  assert.deepEqual(
    retentionQuoStatsDateInput({}, Date.parse("2026-08-16T12:00:00.000Z")),
    {
      from: "2026-07-17T12:00:00.000Z",
      to: "2026-08-16T12:00:00.000Z",
    },
  );
  assert.deepEqual(
    validateRetentionQuoStatsQuery({ from: "not-a-date", to: "2026-08-16" }),
    { ok: false, error: "Invalid date range." },
  );
});

test("QUO stats service preserves payload assembly and administrator cache counts", async () => {
  let blockedCalls = 0;
  let aggregateCalls = 0;
  let syncCalls = 0;
  let capturedInput: RetentionQuoAggregationInput | undefined;
  let now = Date.parse("2026-08-16T12:00:00.000Z");
  const repository: RetentionQuoRepository = {
    async loadAuthorizationAgentDirectory() {
      assert.fail("administrator requests must not load the mutable directory");
    },
    async loadBlockedNumbers() {
      blockedCalls += 1;
      return new Set(["+15550000000"]);
    },
    async loadPhoneStatsAggregates(input) {
      aggregateCalls += 1;
      capturedInput = input;
      return {
        rows: [
          aggregateRow({ kind: "team" }),
          aggregateRow({ kind: "all", resolvedTeam: null }),
          aggregateRow({
            kind: "line",
            resolvedTeam: null,
            agentName: null,
            lineId: "line-retention",
            lineName: "Retention Line",
            outbound: 0,
            inbound: 3,
            lastCall: null,
          }),
          aggregateRow({
            kind: "meta",
            resolvedTeam: null,
            agentName: null,
            day: null,
            totalCalls: 4,
            lastCall: null,
          }),
        ],
        timings: { dimensionQueryMs: 2, aggregateQueryMs: 3, databaseMs: 5 },
        dimensionsLoaded: 1,
        dimensionsAuthorized: 1,
      };
    },
    async loadSyncState() {
      syncCalls += 1;
      return { lastSyncedAt: new Date("2026-08-16T11:00:00.000Z"), isSyncing: false };
    },
  };
  let tick = 0;
  const service = new RetentionQuoStatsService({
    repository,
    now: () => now,
    performanceNow: () => tick++,
  });
  const input = {
    actor: admin,
    query: { from: "2026-08-16", to: "2026-08-16" },
  };

  const first = await service.getStats(input);
  const second = await service.getStats(input);
  const payload = JSON.parse(first.body);

  assert.equal(first.cache, "miss");
  assert.equal(second.cache, "hit");
  assert.equal(second.body, first.body);
  assert.deepEqual({ blockedCalls, aggregateCalls, syncCalls }, {
    blockedCalls: 1,
    aggregateCalls: 1,
    syncCalls: 1,
  });
  assert.equal(capturedInput?.fromDate.toISOString(), "2026-08-16T07:00:00.000Z");
  assert.equal(capturedInput?.toDate.toISOString(), "2026-08-17T07:00:00.000Z");
  assert.deepEqual([...capturedInput!.blockedNumbers], ["+15550000000"]);
  assert.equal(payload.teamStats.retention["Agent Alpha"]["2026-08-16"].totalCalls, 3);
  assert.equal(payload.allAgentStats["Agent Alpha"]["2026-08-16"].uniqueContacts, 2);
  assert.equal(payload.lineInbound["line-retention"]["2026-08-16"].received, 3);
  assert.equal(payload.agentLastCall.retention["Agent Alpha"], "2026-08-16T18:00:00.000Z");
  assert.equal(payload.totalRows, 4);
  assert.equal(payload.lastSyncedAt, "2026-08-16T11:00:00.000Z");

  now += 15_001;
  assert.equal((await service.getStats(input)).cache, "miss");
  assert.deepEqual({ blockedCalls, aggregateCalls, syncCalls }, {
    blockedCalls: 2,
    aggregateCalls: 2,
    syncCalls: 2,
  });
});

test("QUO stats service bypasses cache and reapplies mutable non-admin scope", async () => {
  let directoryCalls = 0;
  let aggregateCalls = 0;
  const repository: RetentionQuoRepository = {
    async loadAuthorizationAgentDirectory() {
      directoryCalls += 1;
      return createAuthorizationAgentDirectory([
        { id: 11, name: "Agent Alpha", arabicName: null, team: "retention", active: true },
        { id: 12, name: "Agent Beta", arabicName: null, team: "cs", active: true },
      ]);
    },
    async loadBlockedNumbers() {
      return new Set();
    },
    async loadPhoneStatsAggregates(input) {
      aggregateCalls += 1;
      const alpha = input.resolveDimension({
        rawAgentName: "Agent Alpha",
        lineName: "Retention Line",
        lineTeam: "retention",
      });
      const beta = input.resolveDimension({
        rawAgentName: "Agent Beta",
        lineName: "CS Line",
        lineTeam: "cs",
      });
      assert.equal(alpha.authorized, true);
      assert.equal(beta.authorized, false);
      return {
        rows: [aggregateRow({ kind: "team" }), aggregateRow({ kind: "meta", totalCalls: 3 })],
        timings: { dimensionQueryMs: 1, aggregateQueryMs: 1, databaseMs: 2 },
        dimensionsLoaded: 2,
        dimensionsAuthorized: 1,
      };
    },
    async loadSyncState() {
      return null;
    },
  };
  const service = new RetentionQuoStatsService({
    repository,
    now: () => Date.parse("2026-08-16T12:00:00.000Z"),
    performanceNow: () => 1,
  });
  const input = {
    actor: retentionViewer,
    query: { from: "2026-08-16", to: "2026-08-16" },
  };

  assert.equal((await service.getStats(input)).cache, "bypass");
  assert.equal((await service.getStats(input)).cache, "bypass");
  assert.deepEqual({ directoryCalls, aggregateCalls }, { directoryCalls: 2, aggregateCalls: 2 });
});
