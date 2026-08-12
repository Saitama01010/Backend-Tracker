import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLiveStatusSnapshot,
  isSupersededLiveObservation,
  LIVE_STATUS_MAX_STALE_MS,
  syntheticPollingDisplayDelayMs,
} from "../lib/liveStatus.js";

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(percentileValue * ordered.length) - 1)]!;
}

test("five-second polling observes ten starts and ten ends within the freshness budget", () => {
  const offsets = [100, 350, 700, 1_250, 1_900, 2_500, 3_100, 3_600, 4_100, 4_900];
  const starts = offsets.map((offset) => syntheticPollingDisplayDelayMs(offset));
  const ends = offsets.map((offset) => syntheticPollingDisplayDelayMs(offset));
  assert.ok(percentile(starts, 0.5) <= 5_000);
  assert.ok(percentile(starts, 0.95) <= 5_000);
  assert.ok(percentile(ends, 0.5) <= 5_000);
  assert.ok(percentile(ends, 0.95) <= 5_000);
  assert.ok(Math.max(...starts, ...ends) < 5_000);
});

test("live status becomes visibly stale and then expires instead of looking current forever", () => {
  const source = new Date("2026-08-12T12:00:00.000Z");
  const fresh = buildLiveStatusSnapshot(new Date(source.getTime() + 5_000), [
    { agentName: "Synthetic Agent", participant: "synthetic-participant", observedAt: source },
  ]);
  assert.equal(fresh.fresh, true);
  assert.deepEqual(fresh.active, ["Synthetic Agent"]);

  const stale = buildLiveStatusSnapshot(new Date(source.getTime() + 60_000), [
    { agentName: "Synthetic Agent", participant: "synthetic-participant", observedAt: source },
  ]);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.active, ["Synthetic Agent"]);

  const expired = buildLiveStatusSnapshot(new Date(source.getTime() + LIVE_STATUS_MAX_STALE_MS + 1), [
    { agentName: "Synthetic Agent", participant: "synthetic-participant", observedAt: source },
  ]);
  assert.equal(expired.stale, true);
  assert.deepEqual(expired.active, []);

  const mixed = buildLiveStatusSnapshot(new Date(source.getTime() + LIVE_STATUS_MAX_STALE_MS + 1), [
    { agentName: "Expired Agent", participant: null, observedAt: source },
    { agentName: "Fresh Agent", participant: null, observedAt: new Date(source.getTime() + LIVE_STATUS_MAX_STALE_MS) },
  ]);
  assert.deepEqual(mixed.active, ["Fresh Agent"]);
});

test("a completion observation suppresses older fallback state without hiding a newer start", () => {
  const oldPoll = new Date("2026-08-12T12:00:00.000Z");
  const completed = new Date("2026-08-12T12:00:02.000Z");
  const nextStart = new Date("2026-08-12T12:00:04.000Z");

  assert.equal(isSupersededLiveObservation(oldPoll, completed), true);
  assert.equal(isSupersededLiveObservation(nextStart, completed), false);
  assert.equal(isSupersededLiveObservation(nextStart, undefined), false);
});
