import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPbxSnapshot,
  buildPbxSnapshot,
  getCallHistoryCache,
  pbxRuntimeState,
  type PbxDurableSnapshot,
} from "./pbx.state.js";

function snapshot(fetchedAt: number): PbxDurableSnapshot {
  return {
    callHistory: [{ agentName: "Agent Alpha", calls: 2, inbound: 1, outbound: 1, answered: 1, missed: 1, voicemail: 0, durationSeconds: 60, lastCallAt: null, firstCallAt: null }],
    fetchedAt,
    ringGroupMissed: { 7: 3 },
    missedNoCallback: [{ id: 8, fromNumber: "+15550000001", toNumber: "+15550000002", createdAt: "2026-08-16T10:00:00.000Z", ringGroupId: 7, ringGroupName: "Retention Main", team: "retention", source: "pbx" }],
    ringGroupNames: [[7, "Retention Main"]],
    internalNumbers: ["5550000002"],
    lineRingGroups: [["+15550000002", 7]],
    seenMissedCallIds: [8],
    cumulativeDate: "2026-08-16",
    cumulativeMissedByHour: { 10: { retention: 3, cs: 0, nsf: 0 } },
    callSpans: [["agent alpha", [{ start: 1, end: 2 }]]],
    callTimestamps: [["agent alpha", [{ at: "2026-08-16T10:00:00.000Z", source: "pbx", id: "pbx:8" }]]],
  };
}

test("PBX durable snapshots hydrate every shared cache and reject stale state", () => {
  const fresh = snapshot(10_000);
  assert.equal(applyPbxSnapshot(fresh), true);
  assert.equal(applyPbxSnapshot(snapshot(9_999)), false);
  assert.equal(getCallHistoryCache()[0]?.agentName, "Agent Alpha");
  assert.equal(pbxRuntimeState.cumulativeRingGroupMissed[7], 3);
  assert.equal(pbxRuntimeState.ringGroupNames.get(7), "Retention Main");
  assert.deepEqual(pbxRuntimeState.internalNumbers, ["5550000002"]);
  assert.equal(pbxRuntimeState.callSpans.get("agent alpha")?.[0]?.end, 2);
  assert.equal(pbxRuntimeState.callTimestamps.get("agent alpha")?.[0]?.id, "pbx:8");
  assert.deepEqual(buildPbxSnapshot(), fresh);
});
