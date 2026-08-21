import assert from "node:assert/strict";
import test from "node:test";
import type { AuthPayload } from "../../middleware/authCore.js";
import { PbxMissedReportingService } from "./pbx.missed.service.js";
import { isPbxGhostCall, normalizeCustomerPhone, normalizePhone, phoneComparisonKeys } from "./pbx.phone.js";
import {
  parsePbxBreakdownQuery,
  parsePbxCallbackReviewQuery,
  parsePbxDailyQuery,
  parsePbxHourlyQuery,
} from "./pbx.schemas.js";

function breakdownStubs() {
  return {
    async loadBlockedNumbers() { return new Set<string>(); },
    async listQuoBreakdown() { return []; },
    async listPbxBreakdown() { return []; },
    async listOutboundBreakdown() { return []; },
    async listQuoCallbackReview() { return []; },
    async listPbxCallbackReview() { return []; },
    async listOutboundCallbackReview() { return []; },
  };
}

function hourlyStubs() {
  return {
    async listQuoHourly() { return []; },
    async listQuoGhostHourly() { return []; },
    async listPbxHourly() { return []; },
  };
}

function dailyStubs() {
  return {
    ...hourlyStubs(),
    ...breakdownStubs(),
    async listQuoDaily() { return []; },
    async listQuoGhostDaily() { return []; },
    async listPbxDaily() { return []; },
  };
}

test("PBX hourly parsing preserves date validation and mode defaults", () => {
  const now = new Date("2026-08-16T18:00:00.000Z");
  assert.deepEqual(parsePbxHourlyQuery({}, now), {
    ok: true,
    value: { date: "2026-08-16", mode: "times" },
  });
  assert.deepEqual(parsePbxHourlyQuery({ date: "2026-02-30", mode: "numbers" }, now), {
    ok: false,
    error: "Invalid date; expected YYYY-MM-DD.",
  });
  assert.deepEqual(parsePbxHourlyQuery({ date: "2026-08-15", mode: "anything" }, now), {
    ok: true,
    value: { date: "2026-08-15", mode: "times" },
  });
});

test("PBX hourly reporting preserves source buckets, ordering, and live-today behavior", async () => {
  let historicalQueries = 0;
  const repository = {
    ...breakdownStubs(),
    ...dailyStubs(),
    async listQuoHourly() {
      return [
        { hour: 10, team: "retention", count: 2 },
        { hour: 9, team: "cs", count: 1 },
        { hour: 9, team: "other", count: 99 },
      ];
    },
    async listQuoGhostHourly() {
      return [{ hour: 10, team: "retention", count: 1 }];
    },
    async listPbxHourly() {
      historicalQueries += 1;
      return [{ hour: 10, team: "retention", count: 99 }];
    },
  };
  const service = new PbxMissedReportingService(repository, () => new Date("2026-08-16T18:00:00.000Z"));
  const result = await service.getHourly({
    query: { date: "2026-08-16", mode: "times" },
    internalNumbers: ["15550000000"],
    livePbxByHour: {
      10: { retention: 3, cs: 0, nsf: 1 },
    },
  });

  assert.equal(historicalQueries, 0);
  assert.deepEqual(result, {
    date: "2026-08-16",
    hours: [
      {
        hour: 9,
        retention: { quo: 0, ghost: 0, pbx: 0 },
        cs: { quo: 1, ghost: 0, pbx: 0 },
        nsf: { quo: 0, ghost: 0, pbx: 0 },
      },
      {
        hour: 10,
        retention: { quo: 2, ghost: 1, pbx: 3 },
        cs: { quo: 0, ghost: 0, pbx: 0 },
        nsf: { quo: 0, ghost: 0, pbx: 1 },
      },
    ],
  });
});

test("PBX hourly historical and numbers modes query persisted PBX rows", async () => {
  const calls: Array<{ date: string; mode: string }> = [];
  const repository = {
    ...breakdownStubs(),
    ...dailyStubs(),
    async listQuoHourly() { return []; },
    async listQuoGhostHourly() { return []; },
    async listPbxHourly(input: { date: string; mode: string }) {
      calls.push(input);
      return [{ hour: 8, team: "nsf", count: 4 }];
    },
  };
  const service = new PbxMissedReportingService(repository, () => new Date("2026-08-16T18:00:00.000Z"));
  const result = await service.getHourly({
    query: { date: "2026-08-15", mode: "numbers" },
    internalNumbers: [],
    livePbxByHour: {},
  });
  assert.deepEqual(calls, [{ date: "2026-08-15", mode: "numbers" }]);
  assert.equal(result.hours[0]?.nsf.pbx, 4);
});

test("PBX daily reporting preserves 14-day queries, descending dates, and live-cache max semantics", async () => {
  assert.deepEqual(parsePbxDailyQuery({ mode: "numbers" }), { mode: "numbers" });
  assert.deepEqual(parsePbxDailyQuery({ mode: "invalid" }), { mode: "times" });
  const fromValues: number[] = [];
  const repository = {
    ...breakdownStubs(),
    async listQuoHourly() { return []; },
    async listQuoGhostHourly() { return []; },
    async listPbxHourly() { return []; },
    async listQuoDaily(input: { from: Date }) {
      fromValues.push(input.from.getTime());
      return [
        { date: "2026-08-15", team: "retention", count: 2 },
        { date: "2026-08-16", team: "cs", count: 1 },
      ];
    },
    async listQuoGhostDaily(input: { from: Date }) {
      fromValues.push(input.from.getTime());
      return [{ date: "2026-08-15", team: "retention", count: 1 }];
    },
    async listPbxDaily(input: { from: Date }) {
      fromValues.push(input.from.getTime());
      return [
        { date: "2026-08-16", team: "retention", count: 2 },
        { date: "2026-08-15", team: "nsf", count: 3 },
      ];
    },
  };
  const now = new Date("2026-08-16T18:00:00.000Z");
  const service = new PbxMissedReportingService(repository, () => now);
  const result = await service.getDaily({
    query: { mode: "times" },
    internalNumbers: ["15550000000"],
    liveRingGroupMissed: { 10: 5, 11: 1 },
    ringGroupNames: new Map([[10, "Retention Main"], [11, "Other Queue"]]),
  });
  assert.equal(fromValues.every((value) => value === now.getTime() - 14 * 24 * 60 * 60 * 1000), true);
  assert.deepEqual(result.days.map((day) => day.date), ["2026-08-16", "2026-08-15"]);
  assert.equal(result.days[0]?.retention.pbx, 5);
  assert.equal(result.days[1]?.retention.quo, 2);
  assert.equal(result.days[1]?.retention.ghost, 1);
  assert.equal(result.days[1]?.nsf.pbx, 3);
});

test("PBX daily numbers mode never overlays the live accumulator", async () => {
  const repository = {
    ...breakdownStubs(),
    async listQuoHourly() { return []; },
    async listQuoGhostHourly() { return []; },
    async listPbxHourly() { return []; },
    async listQuoDaily() { return []; },
    async listQuoGhostDaily() { return []; },
    async listPbxDaily() { return [{ date: "2026-08-16", team: "retention", count: 2 }]; },
  };
  const service = new PbxMissedReportingService(repository, () => new Date("2026-08-16T18:00:00.000Z"));
  const result = await service.getDaily({
    query: { mode: "numbers" },
    internalNumbers: [],
    liveRingGroupMissed: { 10: 99 },
    ringGroupNames: new Map([[10, "Retention Main"]]),
  });
  assert.equal(result.days[0]?.retention.pbx, 2);
});

test("PBX phone matching and ghost rules retain their exact compatibility behavior", () => {
  assert.equal(normalizePhone("+1 (555) 000-3000"), "5550003000");
  assert.equal(normalizeCustomerPhone("555-000-3000"), "+15550003000");
  assert.deepEqual(phoneComparisonKeys("+1 (555) 000-3000"), ["5550003000", "+15550003000"]);
  assert.equal(isPbxGhostCall("no-answer", 0, null), true);
  assert.equal(isPbxGhostCall("voicemail", 0, null), true);
  assert.equal(isPbxGhostCall("voicemail-brief", 4, null), true);
  assert.equal(isPbxGhostCall("missed", 0, 2), true);
  assert.equal(isPbxGhostCall("missed", 0, 3), false);
});

test("PBX breakdown parsing preserves required and invalid date errors", () => {
  assert.deepEqual(parsePbxBreakdownQuery({}), { ok: false, error: "date required (YYYY-MM-DD)" });
  assert.deepEqual(parsePbxBreakdownQuery({ date: "2026-02-30" }), {
    ok: false,
    error: "Invalid date; expected YYYY-MM-DD.",
  });
  assert.deepEqual(parsePbxBreakdownQuery({ date: "2026-08-16" }), {
    ok: true,
    value: { date: "2026-08-16" },
  });
});

test("PBX breakdown preserves deduplication, callback ranking, ghost flags, and statistics", async () => {
  const repository = {
    ...dailyStubs(),
    async loadBlockedNumbers() { return new Set(["blocked-number"]); },
    async listQuoBreakdown() {
      return [
        { participant: "+1 (555) 000-3000", team: "retention", createdAt: new Date("2026-08-16T10:00:00Z"), status: "no-answer", durationSeconds: 0, ringDurationSeconds: null },
        { participant: "15550003000", team: "retention", createdAt: new Date("2026-08-16T10:05:00Z"), status: "missed", durationSeconds: 5, ringDurationSeconds: 5 },
        { participant: "+1 555 000 4000", team: "cs", createdAt: new Date("2026-08-16T09:00:00Z"), status: "missed", durationSeconds: 5, ringDurationSeconds: 5 },
        { participant: "2522688125", team: "nsf", createdAt: new Date("2026-08-16T08:00:00Z"), status: "missed", durationSeconds: 5, ringDurationSeconds: 5 },
        { participant: "blocked-number", team: "retention", createdAt: new Date("2026-08-16T07:00:00Z"), status: "missed", durationSeconds: 5, ringDurationSeconds: 5 },
      ];
    },
    async listPbxBreakdown() {
      return [{ fromNumber: "5550003000", team: "retention", createdAt: new Date("2026-08-16T10:10:00Z") }];
    },
    async listOutboundBreakdown() {
      return [
        { participant: "15550003000", createdAt: new Date("2026-08-16T10:20:00Z"), durationSeconds: 30, postAnswerSeconds: 61 },
        { participant: "+1 555 000 4000", createdAt: new Date("2026-08-16T09:05:00Z"), durationSeconds: 30, postAnswerSeconds: null },
      ];
    },
  };
  const actor: AuthPayload = { userId: 1, username: "admin", role: "admin", permissions: [] };
  const service = new PbxMissedReportingService(repository);
  const result = await service.getBreakdown({
    actor,
    query: { date: "2026-08-16" },
    internalNumbers: [],
  });

  assert.deepEqual(result.numbers.map((number) => number.team), ["nsf", "cs", "retention"]);
  assert.equal(result.numbers[0]?.isGhost, true);
  assert.equal(result.numbers[1]?.hasCallback, true);
  assert.equal(result.numbers[1]?.callbackConnected, false);
  assert.equal(result.numbers[2]?.source, "both");
  assert.equal(result.numbers[2]?.missedCount, 3);
  assert.equal(result.numbers[2]?.ghostCount, 1);
  assert.equal(result.numbers[2]?.responseMinutes, 20);
  assert.deepEqual(result.stats, {
    total: 3,
    withCallback: 2,
    connected: 1,
    callbackRate: 0.67,
    connectRate: 0.5,
  });
});

test("PBX breakdown preserves legacy empty shape and full-team authorization", async () => {
  const emptyRepository = {
    ...dailyStubs(),
  };
  const legacyActor: AuthPayload = {
    userId: 2,
    username: "retention-viewer",
    role: "view",
    permissions: ["view_missed_tables"],
    allowedTabs: ["retention"],
  };
  const empty = await new PbxMissedReportingService(emptyRepository).getBreakdown({
    actor: legacyActor,
    query: { date: "2026-08-16" },
    internalNumbers: [],
  });
  assert.deepEqual(empty, {
    date: "2026-08-16",
    numbers: [],
    stats: { total: 0, withCallback: 0, rate: 0 },
  });

  const scopedRepository = {
    ...dailyStubs(),
    async listQuoBreakdown() {
      return [
        { participant: "5550001000", team: "retention", createdAt: new Date("2026-08-16T10:00:00Z"), status: "missed", durationSeconds: 5, ringDurationSeconds: 5 },
        { participant: "5550002000", team: "cs", createdAt: new Date("2026-08-16T11:00:00Z"), status: "missed", durationSeconds: 5, ringDurationSeconds: 5 },
      ];
    },
  };
  const scoped = await new PbxMissedReportingService(scopedRepository).getBreakdown({
    actor: legacyActor,
    query: { date: "2026-08-16" },
    internalNumbers: [],
  });
  assert.deepEqual(scoped.numbers.map((number) => number.team), ["retention"]);
});

test("PBX callback parsing preserves range pairing, caps, and defaults", () => {
  assert.deepEqual(parsePbxCallbackReviewQuery({ from: "2026-08-01" }), {
    ok: false,
    error: "Both from and to are required.",
  });
  assert.equal(parsePbxCallbackReviewQuery({ from: "2026-01-01", to: "2026-08-16" }).ok, false);
  assert.deepEqual(parsePbxCallbackReviewQuery({ days: "1e3" }), {
    ok: false,
    error: "Invalid days; expected an integer from 1 to 90.",
  });
  assert.deepEqual(parsePbxCallbackReviewQuery({}), {
    ok: true,
    value: { kind: "days", days: 14 },
  });
  assert.deepEqual(parsePbxCallbackReviewQuery({ from: "2026-08-01", to: "2026-08-16" }), {
    ok: true,
    value: { kind: "range", from: "2026-08-01", to: "2026-08-16" },
  });
});

test("PBX callback review preserves lookahead, ghost denominators, rates, and response averages", async () => {
  const windows: Array<Record<string, unknown>> = [];
  const outboundWindows: Array<{ from: Date; to: Date }> = [];
  const repository = {
    ...dailyStubs(),
    async listQuoCallbackReview(input: { window: Record<string, unknown> }) {
      windows.push(input.window);
      return [
        { id: "real", participant: "5550001000", team: "retention", lineName: "Retention Main", createdAt: new Date("2026-08-16T10:00:00Z"), durationSeconds: 5, ringDurationSeconds: 5, status: "missed" },
        { id: "ghost", participant: "5550002000", team: "retention", lineName: "Retention Main", createdAt: new Date("2026-08-16T11:00:00Z"), durationSeconds: 0, ringDurationSeconds: null, status: "no-answer" },
      ];
    },
    async listPbxCallbackReview(window: Record<string, unknown>) {
      windows.push(window);
      return [{ id: 3, fromNumber: "5550003000", team: "cs", ringGroupName: "CS Main", createdAt: new Date("2026-08-16T09:00:00Z") }];
    },
    async listOutboundCallbackReview(input: { from: Date; to: Date }) {
      outboundWindows.push(input);
      return [{ participant: "5550001000", createdAt: new Date("2026-08-16T10:12:00Z"), durationSeconds: 20, postAnswerSeconds: 61 }];
    },
  };
  const now = new Date("2026-08-16T18:00:00Z");
  const actor: AuthPayload = { userId: 1, username: "admin", role: "admin", permissions: [] };
  const result = await new PbxMissedReportingService(repository, () => new Date(now)).getCallbackReview({
    actor,
    query: { kind: "days", days: 14 },
    internalNumbers: ["15550000000"],
  });
  const since = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  assert.equal(windows.every((window) => window["kind"] === "since" && (window["since"] as Date).getTime() === since), true);
  assert.equal(outboundWindows[0]?.from.getTime(), since);
  assert.equal(outboundWindows[0]?.to.toISOString(), "2026-08-19T18:00:00.000Z");
  assert.deepEqual(result.items.map((item) => item.id), ["quo-ghost", "quo-real", "pbx-3"]);
  assert.deepEqual(result.stats, {
    total: 2,
    ghost: 1,
    withCallback: 1,
    connected: 1,
    rate: 0.5,
    connectRate: 1,
    avgResponseMinutes: 12,
  });
});
