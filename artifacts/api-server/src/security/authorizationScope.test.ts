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
  { id: 11, name: "Agent Alpha", arabicName: "Alpha Alias", team: "retention", active: true },
  { id: 12, name: "Agent Beta", arabicName: null, team: "cs", active: true },
  { id: 13, name: "Agent Gamma", arabicName: null, team: "killers", active: true },
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

test("canonical provider aliases resolve to immutable self scope and never name-match another row", () => {
  const agent: AuthPayload = {
    ...retentionUser,
    accessModel: "canonical",
    accessRole: "agent",
    selfAgentId: 11,
    selfAgentName: "Agent Alpha",
    selfAgentTeam: "retention",
    fullTeamAccess: [],
  };
  assert.equal(canAccessMetricAgent(agent, "Alpha Alias", directory), true);
  assert.equal(canAccessMetricAgent(agent, "Agent Beta", directory), false);
  assert.equal(canAccessMetricAgent(agent, "Unknown Agent", directory), false);
  assert.equal(canAccessLiveAgent(agent, "Alpha Alias", directory), true);
});

test("canonical sheets are always row-scoped and fail closed without an authoritative identity column", () => {
  const agent: AuthPayload = {
    ...retentionUser,
    accessModel: "canonical",
    accessRole: "agent",
    selfAgentId: 11,
    selfAgentName: "Agent Alpha",
    selfAgentTeam: "retention",
    fullTeamAccess: [],
    allowedTabs: ["backend-stats", "retention"],
  };
  const data = {
    headers: ["Agent Name", "Status"],
    rows: [
      { "Agent Name": "Alpha Alias", Status: "Fixed" },
      { "Agent Name": "Agent Beta", Status: "Fixed" },
    ],
  };
  const result = scopeSheetData(agent, data, directory);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data.rows, [data.rows[0]]);
  assert.equal(scopeSheetData(agent, { headers: ["Status"], rows: [{ Status: "Fixed" }] }, directory).ok, false);
});
