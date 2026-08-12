import assert from "node:assert/strict";
import test from "node:test";
import type { AuthPayload } from "../middleware/authCore.js";
import {
  canAccessLiveAgent,
  canAccessMetricAgent,
  createAuthorizationAgentDirectory,
  scopeSheetData,
} from "../lib/authorizationScope.js";

const directory = createAuthorizationAgentDirectory([
  { name: "Agent Alpha", arabicName: "Alpha Alias", team: "retention" },
  { name: "Agent Beta", arabicName: null, team: "cs" },
  { name: "Agent Gamma", arabicName: null, team: "killers" },
]);
const retentionUser: AuthPayload = {
  userId: 201,
  username: "sanitized-retention-user",
  role: "view",
  permissions: ["view_metrics"],
  teamAccess: "retention",
  allowedTabs: ["retention"],
};

test("metric data is limited to visible teams and configured agents", () => {
  assert.equal(canAccessMetricAgent(retentionUser, "Agent Alpha", directory), true);
  assert.equal(canAccessMetricAgent(retentionUser, "Alpha Alias", directory), true);
  assert.equal(canAccessMetricAgent(retentionUser, "Agent Beta", directory), false);
  assert.equal(canAccessMetricAgent({ ...retentionUser, allowedAgents: ["Agent Beta"] }, "Agent Alpha", directory), false);
  assert.equal(canAccessMetricAgent({ ...retentionUser, allowedAgents: ["Agent Alpha"] }, "Alpha Alias", directory), true);
});

test("live agent data follows teamAccess and agent allowlists", () => {
  assert.equal(canAccessLiveAgent(retentionUser, "Agent Alpha", directory), true);
  assert.equal(canAccessLiveAgent(retentionUser, "Agent Beta", directory), false);
  assert.equal(canAccessLiveAgent({ ...retentionUser, teamAccess: null }, "Agent Beta", directory), true);
});

test("sheet rows are filtered by team, agent, and today-only restrictions without changing shape", () => {
  const data = {
    headers: ["Agent Name", "Timestamp", "Status"],
    rows: [
      { "Agent Name": "Agent Alpha", Timestamp: "2026-07-15 09:00", Status: "Fixed" },
      { "Agent Name": "Agent Alpha", Timestamp: "2026-07-14 09:00", Status: "Fixed" },
      { "Agent Name": "Agent Beta", Timestamp: "2026-07-15 09:00", Status: "Fixed" },
    ],
  };
  const scoped = scopeSheetData({ ...retentionUser, lockToToday: true }, data, directory, new Date("2026-07-15T18:00:00Z"));
  assert.equal(scoped.ok, true);
  if (!scoped.ok) return;
  assert.deepEqual(scoped.data.headers, data.headers);
  assert.deepEqual(scoped.data.rows, [data.rows[0]]);
});

test("unscopable sheets fail closed instead of returning empty success data", () => {
  const result = scopeSheetData(retentionUser, { headers: ["Status"], rows: [{ Status: "Fixed" }] }, directory);
  assert.deepEqual(result, { ok: false, reason: "The requested sheet has no resolvable agent column." });
});
