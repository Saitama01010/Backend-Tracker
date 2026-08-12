import assert from "node:assert/strict";
import test from "node:test";
import {
  adminUserListSchema,
  attendanceSchema,
  authResponseSchema,
  onboardingAnalyticsSchema,
  onboardingStatusSchema,
  quoStatsSchema,
  readyModeStatsSchema,
  samiaDiagnosticsSchema,
  sheetDataSchema,
  teamAgentListSchema,
  violationsSchema,
  vosStatsSchema,
} from "./contracts.js";

const baseUrl = process.env["BASELINE_SMOKE_BASE_URL"]?.replace(/\/$/, "");
const username = process.env["BASELINE_SMOKE_USERNAME"] || "admin";
const password = process.env["BASELINE_SMOKE_PASSWORD"] || process.env["DASHBOARD_PASSWORD"];
const sheetId = process.env["BASELINE_SMOKE_SHEET_ID"];
const sheetGid = process.env["BASELINE_SMOKE_SHEET_GID"];
const enabled = Boolean(baseUrl && password);

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, init);
  assert.equal(response.status, 200, `${init?.method ?? "GET"} ${path} returned ${response.status}`);
  return response;
}

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await request(path, init);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i, `${path} must return JSON`);
  return response.json();
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

test("live baseline smoke: login, dashboard, data workflows, filters, downloads, and admin", { skip: !enabled }, async (t) => {
  let token = "";
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setUTCDate(today.getUTCDate() - 7);
  const from = isoDate(weekAgo);
  const to = isoDate(today);
  const allTimeFrom = "2024-01-01";

  await t.test("application and dashboard HTML load", async () => {
    const health = await json("/api/healthz");
    assert.deepEqual(health, { status: "ok" });

    const response = await request("/");
    assert.match(response.headers.get("content-type") ?? "", /text\/html/i);
    const html = await response.text();
    assert.match(html, /<div id="root"><\/div>/);
  });

  await t.test("login and authenticated identity work", async () => {
    const login = authResponseSchema.parse(await json("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }));
    token = login.token;
    const identity = authResponseSchema.parse(await json("/api/auth/me", { headers: bearer(token) }));
    assert.equal(identity.user.id, login.user.id);
  });

  await t.test("Quo/OpenPhone statistics and date filters return populated contracts", async () => {
    const allTime = quoStatsSchema.parse(await json(`/api/quo/stats?from=${allTimeFrom}&to=${to}`, { headers: bearer(token) }));
    const filtered = quoStatsSchema.parse(await json(`/api/quo/stats?from=${from}&to=${to}`, { headers: bearer(token) }));
    assert.ok(allTime.totalRows > 0, "Quo/OpenPhone baseline must contain rows for dashboard charts and tables");
    assert.ok(Object.keys(allTime.teamStats).length > 0);
    assert.ok(filtered.totalRows >= 0);
  });

  await t.test("PBX statistics return dashboard, agent, and ring-group data", async () => {
    const pbx = vosStatsSchema.parse(await json("/api/vos/stats", { headers: bearer(token) }));
    assert.ok(pbx.dashboard.totalAgents >= 0);
    assert.ok(Array.isArray(pbx.dashboard.callsByAgent));
  });

  await t.test("attendance loads members and accepts a date filter", async () => {
    const attendance = attendanceSchema.parse(await json(`/api/attendance?from=${from}&to=${to}`, { headers: bearer(token) }));
    assert.ok(attendance.members.length > 0, "attendance baseline must contain members");
  });

  await t.test("Google Sheets data returns headers and rows", { skip: !(sheetId && sheetGid) }, async () => {
    const sheet = sheetDataSchema.parse(await json(`/api/sheet?id=${encodeURIComponent(sheetId!)}&gid=${encodeURIComponent(sheetGid!)}`, { headers: bearer(token) }));
    assert.ok(sheet.headers.length > 0, "Google Sheets baseline must contain headers");
    assert.ok(sheet.rows.length > 0, "Google Sheets baseline must contain rows");
  });

  await t.test("onboarding reports and analytics return dashboard data with filters", async () => {
    const status = onboardingStatusSchema.parse(await json(`/api/ob-report/status?from=${allTimeFrom}&to=${to}`, { headers: bearer(token) }));
    const analytics = onboardingAnalyticsSchema.parse(await json(`/api/ob-analytics?from=${allTimeFrom}&to=${to}`, { headers: bearer(token) }));
    assert.ok(status.totalCalls >= 0);
    assert.ok(analytics.kpis.totalCalls >= 0);
    assert.ok(Array.isArray(analytics.agents));
  });

  await t.test("ReadyMode statistics and date filters return their current contract", async () => {
    const readyMode = readyModeStatsSchema.parse(await json(`/api/readymode/stats?from=${from}&to=${to}`, { headers: bearer(token) }));
    assert.equal(readyMode.totals.dialed, readyMode.agents.reduce((sum, agent) => sum + agent.dialed, 0));
    assert.equal(readyMode.totals.connected, readyMode.agents.reduce((sum, agent) => sum + agent.connected, 0));
  });

  await t.test("violations return the current grouped response with filters", async () => {
    violationsSchema.parse(await json(`/api/violations?from=${from}&to=${to}`, { headers: bearer(token) }));
  });

  await t.test("AI/QA and Samia diagnostics load without making a model request", async () => {
    samiaDiagnosticsSchema.parse(await json("/api/samia/diagnostics", { headers: bearer(token) }));
    const qa = await json(`/api/qa/stats?from=${from}&to=${to}&dateBasis=evaluated`, { headers: bearer(token) });
    assert.ok(qa !== null && typeof qa === "object" && !Array.isArray(qa));
    assert.ok(Object.prototype.hasOwnProperty.call(qa, "reviewed"));
  });

  await t.test("exports and downloads still return Excel workbooks", async () => {
    for (const path of [
      `/api/ob-report/download?from=${allTimeFrom}&to=${to}`,
      `/api/ob-analytics/download?from=${allTimeFrom}&to=${to}`,
    ]) {
      const response = await request(path, { headers: bearer(token) });
      assert.match(response.headers.get("content-type") ?? "", /spreadsheetml/i);
      assert.match(response.headers.get("content-disposition") ?? "", /attachment/i);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.ok(bytes.length > 4, `${path} must not be empty`);
      assert.equal(bytes[0], 0x50, `${path} must begin with the XLSX ZIP signature`);
      assert.equal(bytes[1], 0x4b, `${path} must begin with the XLSX ZIP signature`);
    }
  });

  await t.test("admin user and roster data load", async () => {
    const users = adminUserListSchema.parse(await json("/api/users", { headers: bearer(token) }));
    const agents = teamAgentListSchema.parse(await json("/api/team-agents", { headers: bearer(token) }));
    assert.ok(users.length > 0, "admin baseline must contain at least one user");
    assert.ok(agents.length > 0, "roster baseline must contain at least one agent");
  });
});
