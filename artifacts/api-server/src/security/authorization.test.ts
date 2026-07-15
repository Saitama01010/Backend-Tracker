import assert from "node:assert/strict";
import test from "node:test";
import type { AuthPayload } from "../middleware/authCore.js";
import {
  canAccessAgent,
  canAccessAttendanceDepartment,
  canAccessDateRange,
  canAccessMetricTeam,
  canViewSubTab,
  canViewTab,
} from "../middleware/authorizationCore.js";
import { authorizeApiDateParameters, authorizeApiRoute } from "../routes/authorizationPolicy.js";

const normal: AuthPayload = {
  userId: 101,
  username: "sanitized-normal-user",
  role: "view",
  permissions: ["view_metrics", "view_attendance"],
};
const admin: AuthPayload = { ...normal, userId: 1, username: "sanitized-admin", role: "admin", permissions: [] };
const limitedTeam: AuthPayload = {
  ...normal,
  userId: 102,
  username: "sanitized-team-user",
  permissions: ["view_metrics"],
  teamAccess: "retention",
  allowedTabs: ["retention", "missed-no-cb"],
};
const limitedAgent: AuthPayload = { ...limitedTeam, allowedAgents: ["Agent Alpha"] };
const limitedTab: AuthPayload = { ...normal, allowedTabs: ["onboarding"] };
const todayOnly: AuthPayload = { ...limitedTeam, lockToToday: true };

test("admin routes reject ordinary authenticated users with 403 decisions", () => {
  for (const [method, path] of [["GET", "/users"], ["POST", "/qa/process"], ["GET", "/samia/diagnostics"]]) {
    assert.equal(authorizeApiRoute(method, path, normal).allowed, false, `${method} ${path}`);
    assert.equal(authorizeApiRoute(method, path, admin).allowed, true, `${method} ${path}`);
  }
});

test("normal users need the persisted permission as well as a visible tab", () => {
  assert.equal(authorizeApiRoute("GET", "/quo/stats", normal).allowed, true);
  assert.equal(authorizeApiRoute("GET", "/attendance", normal).allowed, true);
  assert.equal(authorizeApiRoute("GET", "/violations", limitedTeam).allowed, false);
  assert.equal(authorizeApiRoute("GET", "/ob-report/status", limitedTab).allowed, true);
  assert.equal(authorizeApiRoute("GET", "/quo/stats", limitedTab).allowed, false);
  assert.equal(authorizeApiRoute("GET", "/attendance", { ...normal, permissions: [] }).allowed, false);
});

test("team access and explicit tab allowlists mirror the dashboard", () => {
  assert.equal(canViewTab(limitedTeam, "retention"), true);
  assert.equal(canViewTab(limitedTeam, "cs"), false);
  assert.equal(canAccessMetricTeam(limitedTeam, "retention"), true);
  assert.equal(canAccessMetricTeam(limitedTeam, "cs"), false);
  assert.equal(canAccessAttendanceDepartment(limitedTeam, "Retention"), true);
  assert.equal(canAccessAttendanceDepartment(limitedTeam, "CS"), false);
  assert.equal(canViewTab({ ...normal, hideBackendStats: true }, "backend-stats"), false);
});

test("agent and subtab allowlists cannot be bypassed by alternate casing or punctuation", () => {
  assert.equal(canAccessAgent(limitedAgent, "Agent Alpha"), true);
  assert.equal(canAccessAgent(limitedAgent, "agent-alpha"), true);
  assert.equal(canAccessAgent(limitedAgent, "Agent Beta"), false);
  assert.equal(canAccessAgent(limitedAgent, "Provider Name", ["Agent Alpha"]), true);
  assert.equal(canViewSubTab({ ...limitedTeam, allowedSubTabs: ["files"] }, "files"), true);
  assert.equal(canViewSubTab({ ...limitedTeam, allowedSubTabs: ["files"] }, "call"), false);
});

test("today-only users cannot submit historical or future date parameters", () => {
  const now = new Date("2026-07-15T18:00:00Z");
  assert.equal(canAccessDateRange(todayOnly, ["2026-07-15", "2026-07-15"], now), true);
  assert.equal(canAccessDateRange(todayOnly, ["2026-07-14", "2026-07-15"], now), false);
  assert.equal(canAccessDateRange(todayOnly, ["2026-07-16"], now), false);
  assert.equal(canAccessDateRange(todayOnly, [], now), false);
  assert.equal(canAccessDateRange(admin, ["2025-01-01"], now), true);
  assert.equal(authorizeApiDateParameters("GET", "/violations", todayOnly, { from: "2026-07-14", to: "2026-07-15" }), false);
  assert.equal(authorizeApiDateParameters("GET", "/violations", todayOnly, { from: "2026-07-15", to: "2026-07-15" }), true);
  assert.equal(authorizeApiDateParameters("GET", "/violations", todayOnly, {}), false);
  assert.equal(authorizeApiDateParameters("PUT", "/attendance/record", todayOnly, {}, { date: "2026-07-14" }), false);
});

test("missing authentication is denied before route authorization and unknown routes default to admin", () => {
  assert.equal(authorizeApiRoute("GET", "/quo/stats", undefined).allowed, false);
  assert.equal(authorizeApiRoute("GET", "/future-private-route", normal).allowed, false);
  assert.equal(authorizeApiRoute("GET", "/future-private-route", admin).allowed, true);
});

test("representative private route inventory is explicitly matched", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/auth/me"], ["GET", "/quo/stats"], ["GET", "/quo/calls"], ["POST", "/quo/sync"],
    ["POST", "/vos/refresh"], ["GET", "/vos/stats"], ["GET", "/vos/missed-daily"], ["GET", "/vos/callback-review"],
    ["GET", "/attendance"], ["POST", "/attendance/members"], ["PATCH", "/attendance/members/1"], ["PUT", "/attendance/record"],
    ["GET", "/sheet"], ["GET", "/csv-proxy"], ["GET", "/readymode/stats"], ["POST", "/readymode/upload"],
    ["GET", "/nsf/readymode-queue"], ["POST", "/nsf/readymode-queue/1/done"], ["GET", "/violations"],
    ["POST", "/violations/verify"], ["GET", "/qa/stats"], ["GET", "/qa/reviews/review-fixture"],
    ["GET", "/ob-report/status"], ["GET", "/ob-analytics/download"], ["GET", "/live-transfers/status"],
    ["GET", "/team-agents"], ["POST", "/team-agents"], ["GET", "/blocked-numbers"], ["GET", "/breaks"],
  ];
  for (const [method, path] of routes) {
    assert.equal(authorizeApiRoute(method, path, admin).matched, true, `${method} ${path}`);
  }
});
