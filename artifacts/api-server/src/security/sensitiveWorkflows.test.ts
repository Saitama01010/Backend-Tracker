import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AuthPayload } from "../middleware/authCore.js";
import { authorizeApiRoute } from "../routes/authorizationPolicy.js";
import {
  escapeLikePattern,
  parseViolationVerificationPayload,
  privateDownloadHeaders,
  validateOptionalWorkflowRange,
  validateWorkflowCalendarDate,
  violationVerificationKeyMatchesPayload,
} from "../lib/sensitiveWorkflowPolicy.js";

const viewer: AuthPayload = {
  userId: 401,
  username: "sanitized-workflow-viewer",
  role: "view",
  permissions: ["view_metrics"],
  allowedTabs: ["onboarding", "violations"],
};
const attendanceEditor: AuthPayload = {
  ...viewer,
  userId: 402,
  permissions: ["view_attendance", "edit_attendance"],
  allowedTabs: null,
  teamAccess: "cs",
};
const memberManager: AuthPayload = {
  ...attendanceEditor,
  userId: 403,
  permissions: ["view_attendance", "manage_members"],
};
const admin: AuthPayload = { ...viewer, userId: 1, role: "admin" };

test("expensive refreshes and destructive verification corrections are admin-only", () => {
  for (const path of ["/ob-report/refresh", "/live-transfers/refresh"]) {
    assert.equal(authorizeApiRoute("POST", path, viewer).allowed, false, path);
    assert.equal(authorizeApiRoute("POST", path, admin).allowed, true, path);
  }
  assert.equal(authorizeApiRoute("POST", "/violations/verify", viewer).allowed, true);
  assert.equal(authorizeApiRoute("DELETE", "/violations/verify", viewer).allowed, false);
  assert.equal(authorizeApiRoute("DELETE", "/violations/verify", admin).allowed, true);
});

test("legitimate reads, downloads, attendance writes, and administration retain explicit permissions", () => {
  for (const path of ["/ob-report/status", "/ob-report/download", "/ob-analytics", "/ob-analytics/download"]) {
    assert.equal(authorizeApiRoute("GET", path, viewer).allowed, true, path);
  }
  assert.equal(authorizeApiRoute("GET", "/attendance", attendanceEditor).allowed, true);
  assert.equal(authorizeApiRoute("PUT", "/attendance/record", viewer).allowed, false);
  assert.equal(authorizeApiRoute("PUT", "/attendance/record", attendanceEditor).allowed, true);
  assert.equal(authorizeApiRoute("POST", "/attendance/auto-mark", attendanceEditor).allowed, true);
  assert.equal(authorizeApiRoute("POST", "/attendance/members", attendanceEditor).allowed, false);
  assert.equal(authorizeApiRoute("POST", "/attendance/import", attendanceEditor).allowed, false);
  assert.equal(authorizeApiRoute("POST", "/attendance/members", memberManager).allowed, true);
  assert.equal(authorizeApiRoute("PATCH", "/attendance/members/42", memberManager).allowed, true);
  assert.equal(authorizeApiRoute("POST", "/attendance/import", memberManager).allowed, true);
  assert.equal(authorizeApiRoute("GET", "/violations/verified", viewer).allowed, true);
  assert.equal(authorizeApiRoute("GET", "/live-transfers/download", viewer).allowed, true);
  assert.equal(authorizeApiRoute("GET", "/qa/download", viewer).allowed, false);
  assert.equal(authorizeApiRoute("POST", "/ob-report/refresh", admin).allowed, true);
  assert.equal(authorizeApiRoute("POST", "/live-transfers/refresh", admin).allowed, true);
  assert.equal(authorizeApiRoute("DELETE", "/violations/verify", admin).allowed, true);
  assert.equal(authorizeApiRoute("GET", "/users", viewer).allowed, false);
  assert.equal(authorizeApiRoute("GET", "/users", admin).allowed, true);
  assert.equal(authorizeApiRoute("PATCH", "/users/42", admin).allowed, true);
  assert.equal(authorizeApiRoute("DELETE", "/users/42", admin).allowed, true);
});

test("violation actor attribution, strict inputs, import failures, and private downloads are wired in production", async () => {
  const routes = new URL("../routes/", import.meta.url);
  const [attendance, violations, obReport, obAnalytics, liveTransfers, qa] = await Promise.all([
    readFile(new URL("attendance.ts", routes), "utf8"),
    readFile(new URL("violations.ts", routes), "utf8"),
    readFile(new URL("obReport.ts", routes), "utf8"),
    readFile(new URL("obAnalytics.ts", routes), "utf8"),
    readFile(new URL("liveTransfers.ts", routes), "utf8"),
    readFile(new URL("qa.ts", routes), "utf8"),
  ]);

  assert.doesNotMatch(violations, /verifiedBy\s*=\s*["']admin["']/);
  assert.match(violations, /verifiedBy:\s*req\.user!\.username/);
  assert.match(violations, /parseViolationVerificationPayload/);
  assert.match(attendance, /validateWorkflowCalendarDate/);
  assert.match(attendance, /response\.ok/);
  assert.match(attendance, /canAccessAttendanceMember/);
  assert.match(attendance, /allowedAgents\?\.length/);
  assert.match(qa, /const resolvedBy = req\.user!\.username/);
  assert.match(qa, /qaAgentScope/);
  assert.match(qa, /predicateFor/);
  assert.match(qa, /departmentScope\.departments/);
  for (const source of [obReport, obAnalytics, liveTransfers, qa]) {
    assert.match(source, /setPrivateDownloadHeaders/);
  }
});

test("verification payloads use the authenticated actor and reject malformed records", () => {
  const valid = parseViolationVerificationPayload({
    key: "late:Sanitized Agent:2026-07-15",
    type: "late_login",
    member: "Sanitized Agent",
    department: "CS",
    date: "2026-07-15",
    details: JSON.stringify({ minutesLate: 12 }),
    verifiedBy: "forged-admin",
  }, "authenticated-viewer");
  assert.equal(valid?.verifiedBy, "authenticated-viewer");
  assert.equal(parseViolationVerificationPayload({ ...valid, date: "2026-02-30" }, "actor"), null);
  assert.equal(parseViolationVerificationPayload({ ...valid, type: "invented" }, "actor"), null);
  assert.equal(parseViolationVerificationPayload({ ...valid, details: "not-json" }, "actor"), null);
  assert.equal(violationVerificationKeyMatchesPayload(valid!), true);
  assert.equal(violationVerificationKeyMatchesPayload({ ...valid!, key: "late:Other Agent:2026-07-15" }), false);

  const missed = parseViolationVerificationPayload({
    key: "missed:42",
    type: "missed_call",
    member: "Sanitized Agent",
    department: "retention",
    date: "2026-07-15",
    details: {
      key: "missed:42",
      date: "2026-07-15",
      team: "retention",
      availableAgents: ["Sanitized Agent"],
    },
  }, "authenticated-viewer");
  assert.equal(violationVerificationKeyMatchesPayload(missed!), true);
  assert.equal(violationVerificationKeyMatchesPayload({ ...missed!, department: "cs" }), false);
  assert.equal(violationVerificationKeyMatchesPayload({ ...missed!, key: "missed:43" }), false);
});

test("workflow dates, wildcard escaping, and private workbook headers are deterministic", () => {
  assert.equal(validateWorkflowCalendarDate("2026-07-15"), true);
  assert.equal(validateWorkflowCalendarDate("2026-07-15-extra"), false);
  assert.deepEqual(validateOptionalWorkflowRange(undefined, undefined), { ok: true, range: null });
  assert.equal(validateOptionalWorkflowRange("2026-07-15", undefined).ok, false);
  assert.equal(validateOptionalWorkflowRange("2026-07-16", "2026-07-15").ok, false);
  assert.equal(validateOptionalWorkflowRange("2026-07-01", "2026-07-15").ok, true);
  assert.equal(escapeLikePattern("Agent%_\\Name"), "Agent\\%\\_\\\\Name");

  const headers = privateDownloadHeaders("QA_Reviews.xlsx");
  assert.equal(headers["Content-Disposition"], 'attachment; filename="QA_Reviews.xlsx"');
  assert.equal(headers["Cache-Control"], "private, no-store, max-age=0, no-transform");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});
