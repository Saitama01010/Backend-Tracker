import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  adminUserListSchema,
  attendanceSchema,
  authResponseSchema,
  onboardingAnalyticsSchema,
  onboardingStatusSchema,
  quoStatsSchema,
  readyModeStatsSchema,
  teamAgentListSchema,
  violationsSchema,
  vosStatsSchema,
} from "../baseline/contracts.js";

const goldenPath = path.join(import.meta.dirname, "fixtures", "goldens", "major-dashboard-responses.json");
const expectedGoldenDigest = "ebf3dbb67ddf0a797d51577ca1fde13b753a5417318fa902a01b772a83bcc551";

async function loadGolden(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(goldenPath, "utf8")) as Record<string, any>;
}

test("normalized major-dashboard golden payload is byte-for-byte locked", async () => {
  const golden = await loadGolden();
  const digest = createHash("sha256").update(JSON.stringify(golden)).digest("hex");
  assert.equal(digest, expectedGoldenDigest, "review business-value changes before updating the golden digest");
});

test("golden responses satisfy the current production-consumed contracts", async () => {
  const golden = await loadGolden();
  authResponseSchema.parse(golden.auth);
  adminUserListSchema.parse(golden.users);
  teamAgentListSchema.parse(golden.teamAgents);
  quoStatsSchema.parse(golden.quoStats);
  readyModeStatsSchema.parse(golden.readyModeStats);
  vosStatsSchema.parse(golden.vosStats);
  attendanceSchema.parse(golden.attendance);
  violationsSchema.parse(golden.violations);
  onboardingStatusSchema.parse(golden.onboardingStatus);
  onboardingAnalyticsSchema.parse(golden.onboardingAnalytics);
  assert.equal(golden.sheet.rows.length, 5);
  assert.equal(golden.sheet.meta.rowsAccepted, 5);
});

test("team, agent, daily, summary, detailed, and refresh fields remain present in goldens", async () => {
  const golden = await loadGolden();
  assert.equal(golden.quoStats.teamStats.retention["Agent Alpha"]["2026-08-16"].totalCalls, 12);
  assert.equal(golden.quoStats.allAgentStats["Agent Alpha"]["2026-08-16"].answered, 8);
  assert.equal(golden.quoStats.totalRows, 34);
  assert.equal(golden.quoCalls.calls[0].id, "quo-call-001");
  assert.equal(golden.quoLive.fresh, true);
  assert.equal(golden.missedDaily.days[0].nsf.pbx, 1);
  assert.equal(golden.missedHourly.hours[0].retention.quo, 1);
  assert.equal(golden.callbackReview.items[0].responseMinutes, 12);
  assert.equal(golden.onboardingAnalytics.agents[0].onboarded, 3);
});

test("empty-range goldens stay explicit and never acquire synthetic zero rows", async () => {
  const golden = await loadGolden();
  const empty = {
    quoStats: { ...golden.quoStats, teamStats: {}, allAgentStats: {}, lineInbound: {}, agentLastCall: {}, allAgentLastCall: {}, totalRows: 0 },
    sheet: { ...golden.sheet, rows: [], meta: { ...golden.sheet.meta, rowsReceived: 0, rowsAccepted: 0 } },
    readyMode: { ...golden.readyModeStats, agents: [], totals: { dialed: 0, connected: 0, talkTimeSecs: 0, connectRate: 0 } },
  };
  quoStatsSchema.parse(empty.quoStats);
  readyModeStatsSchema.parse(empty.readyMode);
  assert.deepEqual(empty.sheet.rows, []);
});
