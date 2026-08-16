import assert from "node:assert/strict";
import test from "node:test";
import { PbxMissedReportingService } from "./pbx.missed.service.js";
import { parsePbxDailyQuery, parsePbxHourlyQuery } from "./pbx.schemas.js";

function dailyStubs() {
  return {
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
