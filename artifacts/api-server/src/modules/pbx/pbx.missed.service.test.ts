import assert from "node:assert/strict";
import test from "node:test";
import { PbxMissedReportingService } from "./pbx.missed.service.js";
import { parsePbxHourlyQuery } from "./pbx.schemas.js";

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
