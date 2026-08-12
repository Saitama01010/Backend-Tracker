import assert from "node:assert/strict";
import test from "node:test";
import type { AuthPayload } from "../middleware/authCore.js";
import { scopeMissedItemsForUser } from "../lib/missedCallScope.js";

type MissedNoCallbackItem = {
  id: string;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "retention" | "nsf" | "cs" | "other";
  source: "pbx" | "quo" | "readymode";
};

const todayOnlyUser: AuthPayload = {
  userId: 9101,
  username: "sanitized-today-user",
  role: "view",
  permissions: ["view_metrics"],
  teamAccess: "retention",
  lockToToday: true,
};

function item(id: string, createdAt: string, team: MissedNoCallbackItem["team"] = "retention"): MissedNoCallbackItem {
  return {
    id,
    fromNumber: "+15550100000",
    toNumber: "+15550100001",
    createdAt,
    ringGroupId: 10,
    ringGroupName: "Sanitized Fixture",
    team,
    source: "quo",
  };
}

test("today-only missed-call serialization excludes prior-day phone data and respects exact boundaries", () => {
  const now = new Date("2026-07-15T18:00:00.000Z");
  const rows = [
    item("prior", "2026-07-15T06:59:59.999Z"),
    item("start", "2026-07-15T07:00:00.000Z"),
    item("end", "2026-07-16T06:59:59.999Z"),
    item("next", "2026-07-16T07:00:00.000Z"),
    item("other-team", "2026-07-15T12:00:00.000Z", "cs"),
  ];
  const scoped = scopeMissedItemsForUser(todayOnlyUser, rows, now);
  assert.deepEqual(scoped.map((row) => row.id), ["start", "end"]);
  assert.equal(scoped.some((row) => row.fromNumber === rows[0]!.fromNumber && row.id === "prior"), false);
});

test("broader authorized users retain the existing 36-hour missed-call behavior", () => {
  const broadUser = { ...todayOnlyUser, lockToToday: false };
  const rows = [
    item("prior", "2026-07-15T06:59:59.999Z"),
    item("today", "2026-07-15T12:00:00.000Z"),
  ];
  assert.deepEqual(scopeMissedItemsForUser(broadUser, rows, new Date("2026-07-15T18:00:00Z")), rows);
});

test("cached rows are scoped again for every user and business day", () => {
  const sharedCache = [
    item("day-one", "2026-12-31T20:00:00.000Z"),
    item("day-two", "2027-01-01T20:00:00.000Z"),
  ];
  assert.deepEqual(
    scopeMissedItemsForUser(todayOnlyUser, sharedCache, new Date("2026-12-31T20:30:00.000Z")).map((row) => row.id),
    ["day-one"],
  );
  assert.deepEqual(
    scopeMissedItemsForUser(todayOnlyUser, sharedCache, new Date("2027-01-01T20:30:00.000Z")).map((row) => row.id),
    ["day-two"],
  );
});
