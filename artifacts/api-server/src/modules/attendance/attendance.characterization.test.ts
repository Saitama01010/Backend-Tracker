import assert from "node:assert/strict";
import test from "node:test";

const originalDatabaseUrl = process.env["DATABASE_URL"];
process.env["DATABASE_URL"] ??= "postgresql://fixture:fixture@127.0.0.1:9/fixture";

test.after(() => {
  if (originalDatabaseUrl === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = originalDatabaseUrl;
});

test("attendance import dates preserve the accepted month and calendar validation", async () => {
  const { parseAttendanceImportDate } = await import("../../routes/attendance.js");

  assert.equal(parseAttendanceImportDate("1-Jan", 2026), "2026-01-01");
  assert.equal(parseAttendanceImportDate(" 31-Dec ", 2027), "2027-12-31");
  assert.equal(parseAttendanceImportDate("31-Feb", 2026), null);
  assert.equal(parseAttendanceImportDate("2026-08-10", 2026), null);
});

test("attendance first-call resolution preserves source minimums and day floors", async () => {
  const { resolveFirstCall } = await import("../../routes/attendance.js");
  const member = { name: "Sanitized Characterization Agent" };
  const dayStart = new Date("2026-08-10T07:00:00.000Z");
  const shiftStart = new Date("2026-08-10T14:00:00.000Z");
  const pbxCalls = new Map([
    ["sanitized characterization agent", new Date("2026-08-10T14:15:00.000Z")],
  ]);
  const quoCalls = new Map([
    ["sanitized characterization agent", new Date("2026-08-10T14:05:00.000Z")],
  ]);

  assert.equal(
    resolveFirstCall(member, dayStart, shiftStart, pbxCalls, quoCalls)?.toISOString(),
    "2026-08-10T14:05:00.000Z",
  );
  assert.equal(
    resolveFirstCall(
      member,
      dayStart,
      shiftStart,
      new Map([["sanitized characterization agent", new Date("2026-08-10T06:59:59.999Z")]]),
      new Map(),
    ),
    null,
  );
  assert.equal(resolveFirstCall(member, dayStart, null, pbxCalls, quoCalls), null);
});

test("attendance late-note formatting preserves minute and hour boundaries", async () => {
  const { lateNote } = await import("../../routes/attendance.js");

  assert.equal(lateNote(10), "late 10min");
  assert.equal(lateNote(60), "late 1h");
  assert.equal(lateNote(125), "late 2h 5min");
});
