import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENDANCE_STATUSES,
  attendanceNoteForWrite,
  canonicalAttendanceStatus,
} from "../lib/attendancePolicy.js";
import {
  addCalendarDays,
  attendanceShiftStart,
  businessDayWindow,
  formatCalendarDate,
  isCalendarDate,
  parseTimestampInTimeZone,
  parseBusinessTimestampCompatibility,
  startOfBusinessDay,
} from "../lib/businessTime.js";
import {
  OperationalConfigurationError,
  buildOperationalConfig,
} from "../lib/operationalConfig.js";

test("attendance write boundaries recognize all canonical historical statuses", () => {
  assert.deepEqual(ATTENDANCE_STATUSES, ["in", "off", "late", "pto", "absent", "nsnc", "conf"]);
  for (const status of ATTENDANCE_STATUSES) assert.equal(canonicalAttendanceStatus(status.toUpperCase()), status);
  assert.equal(canonicalAttendanceStatus(" Day-Off "), "off");
  assert.equal(canonicalAttendanceStatus("no_show_no_call"), "nsnc");
  assert.equal(canonicalAttendanceStatus("confirmed"), "conf");
  assert.equal(canonicalAttendanceStatus("unknown operational state"), null);
  assert.equal(canonicalAttendanceStatus(0), null);
});

test("attendance note writes distinguish omission from an intentional clear", () => {
  assert.equal(attendanceNoteForWrite("sanitized note", null), "sanitized note");
  assert.equal(attendanceNoteForWrite(undefined, "existing note"), "existing note");
  assert.equal(attendanceNoteForWrite(null, "existing note"), null);
  assert.equal(attendanceNoteForWrite(null, null), null);
});

test("calendar arithmetic crosses month, year, and leap-day boundaries without 24-hour assumptions", () => {
  assert.equal(addCalendarDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addCalendarDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addCalendarDays("2028-03-01", -1), "2028-02-29");
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(isCalendarDate("2028-02-29"), true);
});

test("Los Angeles business-day windows represent DST days exactly", () => {
  const spring = businessDayWindow("2026-03-08", "America/Los_Angeles");
  assert.equal(spring.start.toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(spring.endExclusive.toISOString(), "2026-03-09T07:00:00.000Z");
  assert.equal((spring.endExclusive.getTime() - spring.start.getTime()) / 3_600_000, 23);

  const fall = businessDayWindow("2026-11-01", "America/Los_Angeles");
  assert.equal(fall.start.toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(fall.endExclusive.toISOString(), "2026-11-02T08:00:00.000Z");
  assert.equal((fall.endExclusive.getTime() - fall.start.getTime()) / 3_600_000, 25);
  assert.equal(formatCalendarDate(new Date("2026-11-02T07:59:59.999Z"), "America/Los_Angeles"), "2026-11-01");
});

test("zoneless provider timestamps use the configured timezone offset for that date", () => {
  assert.equal(
    parseTimestampInTimeZone("2026-07-15 12:00:00", "America/Los_Angeles").toISOString(),
    "2026-07-15T19:00:00.000Z",
  );
  assert.equal(
    parseTimestampInTimeZone("2026-01-15 12:00:00", "America/Los_Angeles").toISOString(),
    "2026-01-15T20:00:00.000Z",
  );
  assert.equal(
    parseTimestampInTimeZone("2026-07-15T19:00:00Z", "America/Los_Angeles").toISOString(),
    "2026-07-15T19:00:00.000Z",
  );
});

test("attendance shifts preserve historical output and use Cairo rules after the compatibility cutover", () => {
  assert.equal(attendanceShiftStart("2026-03-08", "4")?.toISOString(), "2026-03-08T15:00:00.000Z");
  assert.equal(attendanceShiftStart("2026-07-15", "4")?.toISOString(), "2026-07-15T14:00:00.000Z");
  assert.equal(attendanceShiftStart("2026-08-10", "4")?.toISOString(), "2026-08-10T13:00:00.000Z");
  assert.equal(attendanceShiftStart("2026-12-01", "4")?.toISOString(), "2026-12-01T14:00:00.000Z");
  assert.equal(attendanceShiftStart("2026-08-10", "not-a-shift"), null);
});

test("fixed historical date ranges retain the pre-change sanitized report totals", () => {
  const rows = [
    { date: "2026-02-28", status: "in" },
    { date: "2026-03-08", status: "late" },
    { date: "2026-03-09", status: "off" },
    { date: "2026-03-09", status: "pto" },
    { date: "2026-10-31", status: "absent" },
    { date: "2026-11-01", status: "nsnc" },
    { date: "2026-11-02", status: "conf" },
    { date: "2026-12-31", status: "in" },
    { date: "2027-01-01", status: "late" },
  ];
  const summarize = (from: string, to: string) => rows
    .filter((row) => row.date >= from && row.date <= to)
    .reduce<Record<string, number>>((totals, row) => ({ ...totals, [row.status]: (totals[row.status] ?? 0) + 1 }), {});
  assert.deepEqual(summarize("2026-02-28", "2026-03-09"), { in: 1, late: 1, off: 1, pto: 1 });
  assert.deepEqual(summarize("2026-10-31", "2026-11-02"), { absent: 1, nsnc: 1, conf: 1 });
  assert.deepEqual(summarize("2026-12-31", "2027-01-01"), { in: 1, late: 1 });
});

test("operational configuration defaults stay compatible and invalid overrides fail closed", () => {
  const config = buildOperationalConfig({}, new Date("2027-01-01T12:00:00Z"));
  assert.equal(config.businessTimeZone, "America/Los_Angeles");
  assert.equal(config.staffTimeZone, "Africa/Cairo");
  assert.equal(config.attendanceImportYear, 2027);
  assert.equal(config.retentionCutoverDate, "2026-05-04");
  assert.equal(config.lineIds.retentionMain, "PN0uO5PSsk");
  assert.equal(config.attendanceImportSources[0]?.gid, 2_116_872_008);

  const configured = buildOperationalConfig({
    ATTENDANCE_IMPORT_YEAR: "2025",
    BUSINESS_TIMEZONE: "America/New_York",
    TRACKED_TEAM_LINE_NAMES: "Retention,CS Team",
    ANTHROPIC_MODEL_ALLOWLIST: "approved-model",
    ANTHROPIC_SAMIA_MODEL: "approved-model",
    ANTHROPIC_QA_MODEL: "approved-model",
    ANTHROPIC_LT_MODEL: "approved-model",
    ANTHROPIC_OB_MODEL: "approved-model",
  });
  assert.equal(configured.attendanceImportYear, 2025);
  assert.equal(configured.businessTimeZone, "America/New_York");
  assert.deepEqual(configured.trackedTeamLines, ["Retention", "CS Team"]);

  for (const env of [
    { BUSINESS_TIMEZONE: "Mars/Olympus" },
    { RETENTION_CUTOVER_DATE: "2026-02-30" },
    { ATTENDANCE_IMPORT_YEAR: "1999" },
    { QUO_LINE_TEAM_MAP_JSON: "{bad json" },
    { DASHBOARD_SHEET_SOURCES_JSON: "{}" },
    { ANTHROPIC_SAMIA_MODEL: "unapproved-model" },
  ]) {
    assert.throws(() => buildOperationalConfig(env), OperationalConfigurationError);
  }
});

test("business-day midnight is resolved from a calendar date, not the host timezone", () => {
  assert.equal(startOfBusinessDay("2026-01-01", "America/Los_Angeles").toISOString(), "2026-01-01T08:00:00.000Z");
  assert.equal(startOfBusinessDay("2026-07-01", "America/Los_Angeles").toISOString(), "2026-07-01T07:00:00.000Z");
});

test("PBX compatibility preserves the legacy offset before cutover and applies PST afterward", () => {
  assert.equal(parseBusinessTimestampCompatibility("2026-01-15 12:00:00").toISOString(), "2026-01-15T19:00:00.000Z");
  assert.equal(parseBusinessTimestampCompatibility("2026-12-15 12:00:00").toISOString(), "2026-12-15T20:00:00.000Z");
});
