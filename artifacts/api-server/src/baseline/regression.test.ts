import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  IMPORTANT_ENDPOINTS,
  adminUserListSchema,
  attendanceSchema,
  authResponseSchema,
  onboardingAnalyticsSchema,
  onboardingStatusSchema,
  quoStatsSchema,
  readyModeStatsSchema,
  samiaDiagnosticsSchema,
  sheetDataSchema,
  summarizeAttendance,
  summarizeCallKpis,
  summarizeOnboarding,
  summarizeViolations,
  teamAgentListSchema,
  violationsSchema,
  vosStatsSchema,
} from "./contracts.js";

const fixtureUser = {
  id: 101,
  username: "baseline-admin",
  role: "admin" as const,
  permissions: ["view_metrics", "view_attendance"],
  teamAccess: null,
  allowedTabs: null,
  allowedAgents: null,
  allowedSubTabs: null,
  lockToToday: false,
  hideBackendStats: false,
};

const phoneDay = {
  totalCalls: 12,
  talkSeconds: 840,
  inbound: 5,
  outbound: 7,
  answered: 8,
  missed: 4,
  voicemail: 0,
  vmBrief: 0,
  uniqueContacts: 9,
};

test("sanitized API contract fixtures match the important dashboard response shapes", () => {
  authResponseSchema.parse({ token: "sanitized-token", user: fixtureUser });
  adminUserListSchema.parse([{ ...fixtureUser, active: true }]);
  teamAgentListSchema.parse([{ id: 1, name: "Agent Alpha", email: null, team: "retention", active: true }]);

  quoStatsSchema.parse({
    teamStats: { retention: { "Agent Alpha": { "2026-01-15": phoneDay } } },
    allAgentStats: { "Agent Alpha": { "2026-01-15": phoneDay } },
    lineInbound: {
      "line-sanitized": {
        "2026-01-15": {
          lineId: "line-sanitized",
          lineName: "Retention Line",
          received: 5,
          answered: 4,
          missed: 1,
          voicemail: 0,
        },
      },
    },
    agentLastCall: { retention: { "Agent Alpha": "2026-01-15T18:00:00.000Z" } },
    allAgentLastCall: { "Agent Alpha": "2026-01-15T18:00:00.000Z" },
    totalRows: 12,
    lastSyncedAt: "2026-01-15T18:05:00.000Z",
    isSyncing: false,
  });

  readyModeStatsSchema.parse({
    agents: [{
      agentName: "Agent Delta",
      dialed: 10,
      connected: 10,
      talkTimeSecs: 600,
      avgTalkSecs: 60,
      connectRate: 100,
    }],
    totals: { dialed: 10, connected: 10, talkTimeSecs: 600, connectRate: 100 },
    updatedAt: "2026-01-15T18:05:00.000Z",
    raw: "sanitized fixture",
  });

  vosStatsSchema.parse({
    dashboard: {
      activeCalls: 1,
      totalAgents: 2,
      onlineAgents: 2,
      availableAgents: 1,
      totalCallsToday: 9,
      avgDurationToday: 75,
      totalInboundToday: 4,
      totalOutboundToday: 5,
      missedCallsToday: 1,
      callsByAgent: [{ agentName: "Agent Beta", calls: 9, inbound: 4, outbound: 5, avgDuration: 75 }],
      liveCalls: [{
        id: 1,
        direction: "inbound",
        agentName: "Agent Beta",
        phoneLabel: "sanitized-caller",
        ringGroupName: "Support",
        duration: 30,
        startedAt: "2026-01-15T18:00:00.000Z",
      }],
      agentStatuses: [{ id: 1, name: "Agent Beta", extension: "100", status: "available", callsToday: 9 }],
    },
    agents: [{ id: 1, name: "Agent Beta", extension: "100", status: "available", ringGroupIds: [1] }],
    ringGroups: [{ id: 1, name: "Support", agentIds: [1] }],
  });

  attendanceSchema.parse({
    members: [{ id: 1, name: "Agent Alpha", shift: "8", shiftHours: "8", department: "Retention", active: true }],
    records: [{ id: 1, memberId: 1, date: "2026-01-15", status: "in", note: null, coaching: false }],
    timezone: "America/Los_Angeles",
  });

  sheetDataSchema.parse({
    headers: ["Agent", "Status"],
    rows: [{ Agent: "Agent Alpha", Status: "Retained", __col0: "Agent Alpha", __col1: "Retained" }],
  });

  onboardingStatusSchema.parse({
    running: false,
    progressDone: 4,
    progressTotal: 4,
    lastRunAt: "2026-01-15T18:00:00.000Z",
    lastError: null,
    totalCalls: 4,
    classified: 4,
    typeCounts: { onboarded: 3, connection: 1 },
    taxYes: 1,
    taxNo: 3,
  });

  onboardingAnalyticsSchema.parse({
    meta: {
      line: "Onboarding",
      from: "2026-01-01",
      to: "2026-01-31",
      generatedAt: "2026-01-31T18:00:00.000Z",
      dataFirst: "2026-01-01T18:00:00.000Z",
      dataLast: "2026-01-31T18:00:00.000Z",
      totalAgents: 1,
    },
    kpis: {
      totalCalls: 4,
      inbound: 3,
      outbound: 1,
      answered: 3,
      missed: 1,
      voicemail: 0,
      talkSeconds: 300,
      responseRate: 75,
      missedRatio: 25,
      avgTalkSec: 100,
      avgGapMin: 12,
    },
    agents: [{
      name: "Agent Gamma",
      totalCalls: 4,
      inbound: 3,
      outbound: 1,
      answered: 3,
      missed: 1,
      voicemail: 0,
      talkSeconds: 300,
      uniqueContacts: 4,
      responseRate: 75,
      missedRatio: 25,
      avgGapMin: 12,
      onboarded: 3,
      connection: 1,
      onboardedRate: 75,
    }],
    hourly: [{ hour: 10, calls: 4, inbound: 3, missed: 1, idleMinutes: 12 }],
    peaks: { mostMissedHour: 10, mostAvailableHour: 11, busiestHour: 10 },
    cassie: null,
    insights: ["Sanitized baseline insight"],
  });

  violationsSchema.parse({
    lateLogin: [{
      key: "late-sanitized",
      member: "Agent Alpha",
      department: "Retention",
      date: "2026-01-15",
      shiftStart: "2026-01-15T16:00:00.000Z",
      firstCallAt: "2026-01-15T16:12:00.000Z",
      minutesLate: 12,
    }],
    availabilityGaps: [{
      key: "gap-sanitized",
      member: "Agent Alpha",
      department: "Retention",
      date: "2026-01-15",
      gapCount: 2,
      gaps: [{ start: "2026-01-15T18:00:00.000Z", end: "2026-01-15T18:30:00.000Z", minutes: 30, source: "combined" }],
    }],
    missedWhileAvail: [{
      key: "missed-sanitized",
      pbxCallId: null,
      source: "quo",
      date: "2026-01-15",
      missedAt: "2026-01-15T18:00:00.000Z",
      team: "retention",
      fromNumber: "sanitized-number",
      ringGroupName: "Retention",
      availableAgents: ["Agent Alpha"],
      busyAgents: [],
    }],
    verifiedKeys: [],
  });

  samiaDiagnosticsSchema.parse({
    anthropicKeyExists: true,
    samiaModel: "configured-model",
    qaModel: "configured-qa-model",
    liveTransferModel: "configured-lt-model",
    aiRequestUsageExists: true,
    qaBiweeklyRunsExists: true,
    rateLimits: { requestsPerMinute: 6, requestsPerDay: 50 },
    deploymentEnvironment: "test",
  });
});

test("representative call KPIs preserve total, connected, missed, team, and agent totals", () => {
  const result = summarizeCallKpis([
    { agent: "Agent Alpha", team: "retention", totalCalls: 12, answered: 8, missed: 4 },
    { agent: "Agent Beta", team: "retention", totalCalls: 5, answered: 3, missed: 2 },
    { agent: "Agent Gamma", team: "nsf", totalCalls: 7, answered: 5, missed: 2 },
  ]);

  assert.deepEqual(result.total, { totalCalls: 24, connectedCalls: 16, missedCalls: 8 });
  assert.deepEqual(result.byTeam.retention, { totalCalls: 17, connectedCalls: 11, missedCalls: 6 });
  assert.deepEqual(result.byTeam.nsf, { totalCalls: 7, connectedCalls: 5, missedCalls: 2 });
  assert.deepEqual(result.byAgent["Agent Alpha"], { totalCalls: 12, connectedCalls: 8, missedCalls: 4 });
  assert.deepEqual(result.byAgent["Agent Beta"], { totalCalls: 5, connectedCalls: 3, missedCalls: 2 });
});

test("representative attendance, onboarding, and violation totals remain deterministic", () => {
  assert.deepEqual(
    summarizeAttendance([{ status: "in" }, { status: "in" }, { status: "late" }, { status: "pto" }]),
    { total: 4, byStatus: { in: 2, late: 1, pto: 1 } },
  );
  assert.deepEqual(
    summarizeOnboarding([{ onboarded: 3, connection: 1 }, { onboarded: 2, connection: 2 }]),
    { onboarded: 5, connection: 3 },
  );
  assert.deepEqual(
    summarizeViolations({ lateLogin: [{}, {}], availabilityGaps: [{ gapCount: 2 }, { gapCount: 1 }], missedWhileAvail: [{}] }),
    { late: 2, availability: 3, missed: 1, total: 6 },
  );
});

test("important endpoint declarations remain present in the production routers", async () => {
  const routeNames = [
    "auth", "quo", "vos", "attendance", "sheets", "obReport", "obAnalytics",
    "readymode", "violations", "samia", "users", "teamAgents",
  ];
  const sources = await Promise.all(routeNames.map((name) => readFile(new URL(`../routes/${name}.ts`, import.meta.url), "utf8")));
  const allRoutes = sources.join("\n");

  for (const [method, path] of IMPORTANT_ENDPOINTS) {
    const declaration = `router.${method.toLowerCase()}("${path}"`;
    assert.ok(allRoutes.includes(declaration), `${method} ${path} must remain declared`);
  }
});

test("production source continues to construct the pinned KPI and response fields", async () => {
  const [quo, readyMode, attendance, violations, onboarding, samia, dashboard] = await Promise.all([
    readFile(new URL("../routes/quo.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/readymode.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/attendance.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/violations.ts", import.meta.url), "utf8"),
    readFile(new URL("../modules/onboarding/analytics.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/samia.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../agent-dashboard/src/App.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(quo, /slot\.totalCalls\+\+/);
  assert.match(quo, /effectiveStatus === "completed"/);
  assert.match(quo, /else slot\.missed\+\+/);
  for (const field of ["teamStats", "allAgentStats", "lineInbound", "agentLastCall", "totalRows", "lastSyncedAt", "isSyncing"]) {
    assert.match(quo, new RegExp(`\\b${field}\\b`));
  }

  assert.match(readyMode, /connected: v\.dialed/);
  assert.match(readyMode, /dialed: agents\.reduce/);
  assert.match(readyMode, /connected: agents\.reduce/);
  assert.match(attendance, /res\.json\(\{ members, records, timezone: ATTENDANCE_TIMEZONE \}\)/);
  assert.match(violations, /lateLogin, availabilityGaps, missedWhileAvail, verifiedKeys/);
  assert.match(onboarding, /kpis:/);
  assert.match(onboarding, /agents: agentList/);
  assert.match(samia, /anthropicKeyExists:/);
  assert.match(samia, /rateLimits:/);

  for (const tab of ["backend-stats", "retention", "cs", "nsf", "rmk", "missed-no-cb", "callback-review", "violations", "qa", "onboarding"]) {
    assert.ok(dashboard.includes(`value: "${tab}"`), `dashboard tab ${tab} must remain available`);
  }
  for (const label of ["Quo Lines", "PBX", "ReadyMode"]) {
    assert.ok(dashboard.includes(`label: "${label}"`), `${label} sub-tab must remain available`);
  }
});
