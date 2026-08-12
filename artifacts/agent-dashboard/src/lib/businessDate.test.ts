import assert from "node:assert/strict";
import test from "node:test";
import {
  addCalendarDays,
  businessDateApiRange,
  formatBusinessDate,
  parseStaffTimestamp,
  startOfBusinessDay,
} from "./businessDate";
import { buildDashboardOperationalConfig } from "./dashboardConfig";

test("browser business dates remain calendar-correct at month and year boundaries", () => {
  assert.equal(addCalendarDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
  assert.equal(formatBusinessDate(new Date("2027-01-01T07:59:59.999Z"), "America/Los_Angeles"), "2026-12-31");
});

test("API ranges use true Los Angeles day boundaries across DST", () => {
  assert.deepEqual(businessDateApiRange("2026-03-08", "2026-03-08"), {
    from: "2026-03-08T08:00:00.000Z",
    to: "2026-03-09T06:59:59.999Z",
  });
  assert.deepEqual(businessDateApiRange("2026-11-01", "2026-11-01"), {
    from: "2026-11-01T07:00:00.000Z",
    to: "2026-11-02T07:59:59.999Z",
  });
  assert.equal(startOfBusinessDay("2026-07-15").toISOString(), "2026-07-15T07:00:00.000Z");
});

test("staff timestamps follow Cairo daylight-saving rules", () => {
  assert.equal(parseStaffTimestamp("07/15/2026 16:00:00")?.toISOString(), "2026-07-15T14:00:00.000Z");
  assert.equal(parseStaffTimestamp("08/15/2026 16:00:00")?.toISOString(), "2026-08-15T13:00:00.000Z");
  assert.equal(parseStaffTimestamp("2026-12-01 16:00:00")?.toISOString(), "2026-12-01T14:00:00.000Z");
  assert.equal(parseStaffTimestamp("not-a-date"), null);
});

test("client-visible operational configuration contains no secrets and rejects malformed values", () => {
  const config = buildDashboardOperationalConfig({
    VITE_BUSINESS_TIMEZONE: "America/New_York",
    VITE_RETENTION_CUTOVER_DATE: "2026-06-01",
  });
  assert.equal(config.businessTimeZone, "America/New_York");
  assert.equal(config.retentionCutoverDate, "2026-06-01");
  assert.deepEqual(Object.keys(config).sort(), ["businessTimeZone", "retentionCutoverDate", "sheets", "staffTimeZone", "timezoneCorrectnessCutover"]);
  assert.throws(() => buildDashboardOperationalConfig({ VITE_BUSINESS_TIMEZONE: "not/a-zone" }));
  assert.throws(() => buildDashboardOperationalConfig({ VITE_RETENTION_CUTOVER_DATE: "2026-02-30" }));
  assert.throws(() => buildDashboardOperationalConfig({ VITE_OLD_RETENTION_SHEET_GID: "-1" }));
});
