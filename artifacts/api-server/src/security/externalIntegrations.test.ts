import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseGoogleSheetsValues } from "../integrations/googleSheets/mapper.js";
import type { AuthPayload } from "../middleware/authCore.js";
import {
  approvedReadyModeProbePath,
  approvedVosDebugPath,
  isApprovedSheetSource,
  paginateAuthorizedBatches,
  paginateAfterAuthorization,
  parseBoundedInteger,
  parseSheetGid,
  validateIntegrationCalendarDate,
  validateIntegrationDateRange,
} from "../lib/externalIntegrationPolicy.js";
import { authorizeApiRoute } from "../routes/authorizationPolicy.js";

const normal: AuthPayload = {
  userId: 301,
  username: "sanitized-integration-user",
  role: "view",
  permissions: ["view_metrics", "view_missed_tables"],
  allowedTabs: ["missed-no-cb", "retention"],
};
const edit: AuthPayload = { ...normal, userId: 302, role: "edit" };
const admin: AuthPayload = { ...normal, userId: 1, role: "admin" };

test("manual integration controls are administrator-only", () => {
  for (const path of ["/quo/sync", "/vos/refresh", "/readymode/session/reset"]) {
    assert.equal(authorizeApiRoute("POST", path, normal).allowed, false, path);
    assert.equal(authorizeApiRoute("POST", path, edit).allowed, false, path);
    assert.equal(authorizeApiRoute("POST", path, admin).allowed, true, path);
  }
  assert.equal(authorizeApiRoute("GET", "/readymode/probe", normal).allowed, false);
  assert.equal(authorizeApiRoute("GET", "/readymode/probe", admin).allowed, true);
});

test("integration dates are strict, ordered, and capped without breaking the dashboard all-time range", () => {
  assert.equal(validateIntegrationDateRange("2024-01-01", "2026-07-15").ok, true);
  assert.equal(validateIntegrationDateRange("2026-02-30", "2026-03-01").ok, false);
  assert.equal(validateIntegrationDateRange("not-a-date", "2026-07-15").ok, false);
  assert.equal(validateIntegrationDateRange("2026-07-16", "2026-07-15").ok, false);
  assert.equal(validateIntegrationDateRange("2020-01-01", "2026-07-15").ok, false);
  assert.equal(validateIntegrationDateRange("2026-06-01", "2026-07-15", 31).ok, false);
  assert.equal(validateIntegrationCalendarDate("2026-07-15"), true);
  assert.equal(validateIntegrationCalendarDate("2026-02-30"), false);
});

test("pagination happens only after authorization and numeric controls are bounded", () => {
  const rows = [
    { id: 1, allowed: false },
    { id: 2, allowed: false },
    { id: 3, allowed: true },
    { id: 4, allowed: true },
  ];
  assert.deepEqual(paginateAfterAuthorization(rows, (row) => row.allowed, 0, 1), {
    data: [{ id: 3, allowed: true }],
    total: 2,
  });
  assert.equal(parseBoundedInteger("500", 100, { min: 1, max: 1_000 }), 500);
  assert.equal(parseBoundedInteger("-1", 100, { min: 1, max: 1_000 }), null);
  assert.equal(parseBoundedInteger("1e3", 100, { min: 1, max: 1_000 }), null);
});

test("batched QUO pagination preserves authorized ordering and totals without full materialization", async () => {
  const rows = [
    { id: 1, allowed: false },
    { id: 2, allowed: true },
    { id: 3, allowed: false },
    { id: 4, allowed: true },
    { id: 5, allowed: true },
  ];
  let largestBatch = 0;
  const actual = await paginateAuthorizedBatches(async (offset, limit) => {
    const batch = rows.slice(offset, offset + limit);
    largestBatch = Math.max(largestBatch, batch.length);
    return batch;
  }, (row) => row.allowed, 1, 1, 2);
  assert.deepEqual(actual, { data: [{ id: 4, allowed: true }], total: 3 });
  assert.equal(largestBatch <= 2, true);
  assert.deepEqual(actual, paginateAfterAuthorization(rows, (row) => row.allowed, 1, 1));
});

test("diagnostic paths and Google Sheets sources use exact allowlists", () => {
  assert.equal(approvedReadyModeProbePath("/supervisor/"), "/supervisor/");
  assert.equal(approvedReadyModeProbePath("https://example.invalid/"), null);
  assert.equal(approvedReadyModeProbePath("//example.invalid/"), null);
  assert.equal(approvedReadyModeProbePath("/supervisor/?next=https://example.invalid"), null);
  assert.equal(approvedVosDebugPath("/api/dashboard"), "/api/dashboard");
  assert.equal(approvedVosDebugPath("/api/users"), null);

  const retentionId = "1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o";
  assert.equal(isApprovedSheetSource(retentionId, 837_339_339, ""), true);
  assert.equal(isApprovedSheetSource(retentionId, 0, ""), false);
  assert.equal(isApprovedSheetSource("1UnauthorizedSpreadsheetFixture0000000000000", 0, ""), false);
  assert.equal(parseSheetGid("0"), 0);
  assert.equal(parseSheetGid("871007220"), 871_007_220);
  assert.equal(parseSheetGid("-1"), null);
  assert.equal(parseSheetGid("1.5"), null);
  assert.equal(parseSheetGid("2147483648"), null);
  assert.equal(
    isApprovedSheetSource("1AdditionalSpreadsheetFixture000000000000000", 42, "1AdditionalSpreadsheetFixture000000000000000=42"),
    true,
  );
});

test("Google Sheets upstream payloads distinguish empty data from malformed responses", () => {
  assert.deepEqual(parseGoogleSheetsValues({}), []);
  assert.deepEqual(parseGoogleSheetsValues({ values: [] }), []);
  assert.deepEqual(parseGoogleSheetsValues({ values: [["Agent", "Status"], ["Sanitized Agent", "Fixed"]] }), [
    ["Agent", "Status"],
    ["Sanitized Agent", "Fixed"],
  ]);
  assert.throws(() => parseGoogleSheetsValues(null), /Invalid Google Sheets response/);
  assert.throws(() => parseGoogleSheetsValues({ values: {} }), /Invalid Google Sheets response/);
  assert.throws(() => parseGoogleSheetsValues({ values: ["not-a-row"] }), /Invalid Google Sheets response/);
});

test("Sheets, date ranges, probes, and pagination are wired through integration security policy", async () => {
  const base = new URL("../routes/", import.meta.url);
  const [quo, quoSync, quoClient, sheets, sheetsClient, readymode, readymodeProbe, vos, pbxClient] = await Promise.all([
    readFile(new URL("quo.ts", base), "utf8"),
    readFile(new URL("../integrations/quo/sync.ts", base), "utf8"),
    readFile(new URL("../integrations/quo/client.ts", base), "utf8"),
    readFile(new URL("sheets.ts", base), "utf8"),
    readFile(new URL("../integrations/googleSheets/client.ts", base), "utf8"),
    readFile(new URL("readymode.ts", base), "utf8"),
    readFile(new URL("../integrations/readymode/htmlProbe.ts", base), "utf8"),
    readFile(new URL("vos.ts", base), "utf8"),
    readFile(new URL("../integrations/pbx/client.ts", base), "utf8"),
  ]);

  assert.match(quo, /validateIntegrationDateRange/);
  assert.match(quo, /paginateAuthorizedBatches/);
  assert.match(quo, /fetchQuoJson/);
  assert.doesNotMatch(quo, /QUO_API_KEY|api\.openphone\.com|\bfetch\(/);
  assert.match(quoClient, /QUO_API_KEY/);
  assert.match(quoClient, /response\.status === 429/);
  assert.match(sheets, /isApprovedSheetSource/);
  assert.match(sheets, /const sheetRefreshes = new Map/);
  assert.match(sheetsClient, /const titleRefreshes = new Map/);
  assert.match(sheetsClient, /AbortSignal\.timeout\(15_000\)/);
  assert.match(sheets, /mapGoogleSheetValues/);
  assert.match(sheets, /format === "rows-v1"/);
  assert.match(sheets, /scopeSheetData[\s\S]*?JSON\.stringify\(responsePayload\)/);
  assert.match(sheets, /SHEET_MAX_STALE_MS = 5 \* 60_000/);
  assert.match(readymode, /approvedReadyModeProbePath/);
  assert.match(readymode, /const readyModeSourceCache = new Map/);
  assert.match(readymode, /const readyModeSourceRefreshes = new Map/);
  assert.match(readymode, /AbortSignal\.timeout\(15_000\)/);
  assert.match(readymode, /loadReadyModeSources[\s\S]*?loadAuthorizationAgentDirectory/);
  assert.match(readymode, /readyModeSourceCache\.clear\(\)/);
  assert.match(readymode, /probeReadyModePath/);
  assert.match(readymodeProbe, /READYMODE_USERNAME/);
  assert.doesNotMatch(readymode, /preview:\s*result\.body/);
  assert.doesNotMatch(readymodeProbe, /cookies:\s*cachedCookies/);
  assert.match(vos, /fetchPbxJson/);
  assert.doesNotMatch(vos, /VOSLOGIC_EMAIL|VOSLOGIC_PASSWORD|\/api\/auth\/login/);
  assert.match(pbxClient, /VOSLOGIC_EMAIL/);
  assert.match(pbxClient, /res\.status === 401/);
  assert.doesNotMatch(quoSync, /logger\.(?:info|warn|error)\([^\n]*participant/);
});
