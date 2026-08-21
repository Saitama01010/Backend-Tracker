import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { RetentionQuoCallsService } from "./retention.quo.calls.service.js";
import type { RetentionQuoRepository } from "./retention.quo.repository.js";
import {
  retentionQuoCallsInput,
  validateRetentionQuoCallsTeam,
} from "./retention.schemas.js";
import type { RetentionQuoCallRow } from "./retention.types.js";

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

function callRow(
  id: string,
  agentName: string,
  lineTeam: string,
  createdAt: string,
): RetentionQuoCallRow {
  return {
    id,
    lineTeam,
    lineName: `${lineTeam} line`,
    agentName,
    participant: "+15550000001",
    direction: "outgoing",
    status: "completed",
    durationSeconds: 60,
    createdAt: new Date(createdAt),
  };
}

function repositoryWithRows(
  rows: RetentionQuoCallRow[],
  onLoad?: (from: Date, to: Date, offset: number, limit: number) => void,
): RetentionQuoRepository {
  return {
    async loadAuthorizationAgentDirectory() {
      return createAuthorizationAgentDirectory([
        { id: 11, name: "Agent Alpha", arabicName: null, team: "retention", active: true },
        { id: 12, name: "Agent Alpha Two", arabicName: null, team: "retention", active: true },
        { id: 13, name: "Agent Beta", arabicName: null, team: "cs", active: true },
      ]);
    },
    async loadBlockedNumbers() { return new Set(); },
    async loadPhoneStatsAggregates() { assert.fail("calls service must not aggregate stats"); },
    async loadSyncState() { return null; },
    async loadCallBatch(from, to, offset, limit) {
      onLoad?.(from, to, offset, limit);
      return rows.slice(offset, offset + limit);
    },
  };
}

test("QUO calls parsing preserves pagination-before-team validation", () => {
  assert.deepEqual(retentionQuoCallsInput({ limit: "0", team: "invalid" }), {
    ok: false,
    error: "Invalid pagination parameters.",
  });
  const parsed = retentionQuoCallsInput(
    { from: "2026-08-16", to: "2026-08-16", team: "invalid" },
    Date.parse("2026-08-16T12:00:00.000Z"),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(validateRetentionQuoCallsTeam(parsed.input), {
    ok: false,
    error: "Invalid team.",
  });
});

test("QUO calls service preserves team filtering and California date bounds", async () => {
  let captured: { from: Date; to: Date; offset: number; limit: number } | undefined;
  const rows = [
    callRow("call-retention", "Unmapped Retention Agent", "retention", "2026-08-16T18:00:00.000Z"),
    callRow("call-cs", "Unmapped CS Agent", "cs", "2026-08-16T17:00:00.000Z"),
  ];
  const repository = repositoryWithRows(rows, (from, to, offset, limit) => {
    captured = { from, to, offset, limit };
  });
  repository.loadAuthorizationAgentDirectory = async () => {
    assert.fail("administrator calls must not load the mutable directory");
  };
  const service = new RetentionQuoCallsService(repository);

  const result = await service.listCalls({
    actor: admin,
    query: {
      from: "2026-08-16",
      to: "2026-08-16",
      team: "retention",
      offset: 0,
      limit: 500,
    },
  });

  assert.deepEqual(result.data.map(({ id }) => id), ["call-retention"]);
  assert.equal(result.total, 1);
  assert.equal(captured?.from.toISOString(), "2026-08-16T07:00:00.000Z");
  assert.equal(captured?.to.toISOString(), "2026-08-17T07:00:00.000Z");
  assert.deepEqual({ offset: captured?.offset, limit: captured?.limit }, { offset: 0, limit: 1_000 });
});

test("QUO calls service paginates only after mutable roster authorization", async () => {
  const rows = [
    callRow("call-alpha-1", "Agent Alpha", "retention", "2026-08-16T19:00:00.000Z"),
    callRow("call-beta", "Agent Beta", "cs", "2026-08-16T18:00:00.000Z"),
    callRow("call-alpha-2", "Agent Alpha Two", "retention", "2026-08-16T17:00:00.000Z"),
  ];
  let directoryCalls = 0;
  const repository = repositoryWithRows(rows);
  const originalDirectory = repository.loadAuthorizationAgentDirectory;
  repository.loadAuthorizationAgentDirectory = async () => {
    directoryCalls += 1;
    return originalDirectory();
  };
  const service = new RetentionQuoCallsService(repository);

  const result = await service.listCalls({
    actor: retentionViewer,
    query: {
      from: "2026-08-16",
      to: "2026-08-16",
      team: "retention",
      offset: 1,
      limit: 1,
    },
  });

  assert.deepEqual(result.data.map(({ id }) => id), ["call-alpha-2"]);
  assert.equal(result.total, 2);
  assert.equal(directoryCalls, 1);
});
