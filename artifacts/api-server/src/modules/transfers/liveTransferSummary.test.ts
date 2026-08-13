import assert from "node:assert/strict";
import test from "node:test";
import { summarizeLiveTransferCounts } from "./liveTransferSummary.js";

test("live-transfer totals preserve partner, legacy, unspecified, and department semantics", () => {
  const result = summarizeLiveTransferCounts([
    { kind: "partner", company: "Aspire", cnt: 2 },
    { kind: null, company: "Resync", cnt: 3 },
    { kind: "partner", company: "Unknown Partner", cnt: 4 },
    { kind: "internal", company: "CS", cnt: 5 },
    { kind: "internal", company: "NSF", cnt: 2 },
    { kind: "internal", company: "CS", cnt: 1 },
    { kind: "internal", company: null, cnt: 3 },
  ]);

  assert.deepEqual(result, {
    totalLive: 20,
    partnerTotal: 9,
    aspire: 2,
    resync: 3,
    clarity: 0,
    concordia: 0,
    unspecified: 4,
    internalTotal: 11,
    internalByDept: [
      { dept: "CS", count: 6 },
      { dept: "Other", count: 3 },
      { dept: "NSF", count: 2 },
    ],
  });
});
