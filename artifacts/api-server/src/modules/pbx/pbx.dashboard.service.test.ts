import assert from "node:assert/strict";
import test from "node:test";
import type { AuthPayload } from "../../middleware/authCore.js";
import { PbxDashboardService, type PbxDashboardState } from "./pbx.dashboard.service.js";

const actor = { userId: 1, username: "fixture", role: "admin", permissions: [] } as unknown as AuthPayload;

test("PBX dashboard facade supplies durable cache state to existing reporting services", async () => {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const retention = {
    async getStats(input: unknown) { calls.push({ operation: "stats", input }); return { kind: "stats" }; },
    async getLive(input: unknown) { calls.push({ operation: "live", input }); return { kind: "live" }; },
  };
  const missed = {
    async getHourly(input: unknown) { calls.push({ operation: "hourly", input }); return { kind: "hourly" }; },
    async getDaily(input: unknown) { calls.push({ operation: "daily", input }); return { kind: "daily" }; },
    async getBreakdown(input: unknown) { calls.push({ operation: "breakdown", input }); return { kind: "breakdown" }; },
    async getCallbackReview(input: unknown) { calls.push({ operation: "callback", input }); return { kind: "callback" }; },
  };
  const state: PbxDashboardState = {
    callHistory: [],
    fetchedAt: 123,
    ringGroupMissed: { 7: 4 },
    internalNumbers: ["2025550100"],
    cumulativeMissedByHour: { 10: { retention: 1, cs: 2, nsf: 3 } },
    ringGroupNames: new Map([[7, "Retention"]]),
  };
  let hydrations = 0;
  const service = new PbxDashboardService(
    retention as never,
    missed as never,
    state,
    async () => { hydrations += 1; },
  );

  await service.getStats(actor, { warn() {} } as never);
  await service.getHourly({ date: "2026-08-16", mode: "times" });
  await service.getDaily({ mode: "times" });
  await service.getBreakdown(actor, { date: "2026-08-16" });
  await service.getCallbackReview(actor, { mode: "range", from: "2026-08-16", to: "2026-08-16" } as never);
  await service.getLive(actor);

  assert.equal(hydrations, 1);
  assert.deepEqual(calls.map(({ operation }) => operation), ["stats", "hourly", "daily", "breakdown", "callback", "live"]);
  assert.deepEqual((calls[0]!.input as { cache: unknown }).cache, {
    callHistory: [],
    fetchedAt: 123,
    ringGroupMissed: { 7: 4 },
  });
  assert.deepEqual((calls[1]!.input as { internalNumbers: string[] }).internalNumbers, ["2025550100"]);
  assert.equal((calls[2]!.input as { ringGroupNames: Map<number, string> }).ringGroupNames, state.ringGroupNames);
});
