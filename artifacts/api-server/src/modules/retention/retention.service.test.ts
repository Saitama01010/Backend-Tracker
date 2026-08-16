import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { parseRetentionSheetQuery } from "./retention.schemas.js";
import {
  RetentionService,
  RetentionSheetForbiddenError,
  RetentionSheetSourceNotApprovedError,
  type RetentionServiceDependencies,
} from "./retention.service.js";

const actor: AuthPayload = {
  userId: 201,
  username: "sanitized-retention-user",
  role: "view",
  permissions: ["view_metrics"],
  teamAccess: "retention",
  allowedTabs: ["retention"],
};

function dependencies(overrides: Partial<RetentionServiceDependencies> = {}) {
  let providerCalls = 0;
  const value: RetentionServiceDependencies = {
    repository: {
      async loadAuthorizationAgentDirectory() {
        return createAuthorizationAgentDirectory([
          { id: 11, name: "Agent Alpha", arabicName: "Alpha Alias", team: "retention", active: true },
          { id: 12, name: "Agent Beta", arabicName: null, team: "cs", active: true },
        ]);
      },
    },
    isApprovedSource: () => true,
    titleForGid: async () => "Retention",
    fetchValues: async () => {
      providerCalls += 1;
      return { payload: {}, providerMs: 7 };
    },
    mapValues: () => ({
      data: {
        headers: ["Agent Name", "Status"],
        rows: [
          { "Agent Name": "Agent Alpha", Status: "Retained", __col0: "Agent Alpha", __col1: "Retained" },
          { "Agent Name": "Agent Beta", Status: "Cancelled", __col0: "Agent Beta", __col1: "Cancelled" },
        ],
      },
      rawHeaders: ["Agent Name", "Status"],
      parseMs: 3,
      rowsReceived: 2,
      rowsAccepted: 2,
      rowsSkipped: 0,
    }),
    now: () => new Date("2026-08-16T12:00:00.000Z"),
    performanceNow: (() => {
      let tick = 0;
      return () => tick++;
    })(),
    ...overrides,
  };
  return { value, providerCalls: () => providerCalls };
}

test("Retention sheet query validation preserves the compatibility errors and compact opt-in", () => {
  assert.deepEqual(parseRetentionSheetQuery({}), { ok: false, error: "missing or invalid id" });
  assert.deepEqual(parseRetentionSheetQuery({ id: "approved", gid: "invalid" }), { ok: false, error: "invalid gid" });
  assert.deepEqual(parseRetentionSheetQuery({ id: "approved", gid: "2", format: "rows-v1" }), {
    ok: true,
    query: { spreadsheetId: "approved", gid: 2, compact: true },
  });
});

test("Retention service scopes rows before returning them and preserves one coalesced provider call", async () => {
  const fake = dependencies();
  const service = new RetentionService(fake.value);
  const input = {
    actor,
    query: { spreadsheetId: "approved", gid: 2, compact: true },
  };

  const first = await service.getDashboardSheet(input);
  const second = await service.getDashboardSheet(input);

  assert.deepEqual(first.payload, {
    format: "rows-v1",
    headers: ["Agent Name", "Status"],
    columns: ["Agent Name", "Status"],
    rows: [["Agent Alpha", "Retained"]],
    meta: {
      fetchedAt: "2026-08-16T12:00:00.000Z",
      observedAt: "2026-08-16T12:00:00.000Z",
      stale: false,
      refreshError: false,
      cache: "miss",
      rowsReceived: 1,
      rowsAccepted: 1,
      rowsSkipped: 0,
    },
  });
  assert.equal(second.cache, "hit");
  assert.equal(fake.providerCalls(), 1);
});

test("Retention service rejects unapproved and unscopable sources before returning data", async () => {
  const denied = dependencies({ isApprovedSource: () => false });
  await assert.rejects(
    new RetentionService(denied.value).getDashboardSheet({
      actor,
      query: { spreadsheetId: "denied", gid: 0, compact: false },
    }),
    RetentionSheetSourceNotApprovedError,
  );
  assert.equal(denied.providerCalls(), 0);

  const unscopable = dependencies({
    mapValues: () => ({
      data: { headers: ["Status"], rows: [{ Status: "Retained", __col0: "Retained" }] },
      rawHeaders: ["Status"],
      parseMs: 1,
      rowsReceived: 1,
      rowsAccepted: 1,
      rowsSkipped: 0,
    }),
  });
  await assert.rejects(
    new RetentionService(unscopable.value).getDashboardSheet({
      actor,
      query: { spreadsheetId: "approved", gid: 0, compact: false },
    }),
    RetentionSheetForbiddenError,
  );
});
