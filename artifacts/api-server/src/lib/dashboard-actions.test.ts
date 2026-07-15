import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTENDANCE_TIMEZONE,
  detectSamiaOperationalIntent,
  resolveAttendanceDate,
  resolveAttendanceMember,
} from "./attendancePolicy.js";
import {
  qaEvaluationToolInputSchema,
  parseQaDateBasis,
  qaReviewDateForBasis,
  validateQaResult,
} from "./qaPolicy.js";
import {
  SAMIA_CAPABILITY_REGISTRY,
  executeSamiaCapability,
  hasForbiddenCapabilityInput,
} from "./samiaCapabilities.js";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(libDir, "..");
const repoRoot = path.resolve(apiDir, "../../..");
const routeSource = (name: string) => readFile(path.join(apiDir, "routes", name), "utf8");
const dashboardSource = () => readFile(path.join(repoRoot, "artifacts/agent-dashboard/src/App.tsx"), "utf8");

const validCsEvaluation = {
  department: "CS",
  categoryScores: {
    greeting: 7, empathy: 10, ownership: 10, professionalism: 5, closing: 8,
    attemptedResolution: 15, avoidedUnnecessaryTransfer: 10, handledCancellationConcerns: 10,
    properWarmTransfer: 5, accurateCallbackExpectations: 5, accurateInformation: 10, followedSupportWorkflow: 5,
  },
  score: 100,
  softSkillsScore: 100,
  protocolScore: 100,
  pass: true,
  criticalFail: false,
  strengths: ["Clear communication"],
  missedItems: [],
  criticalIssues: [],
  reason: "Complete and compliant.",
  managerReviewRequired: false,
};

test("QA Today uses evaluated time even when the call is seven days old", () => {
  const review = {
    evaluatedAt: new Date("2026-07-15T16:00:00Z"),
    callDate: new Date("2026-07-08T16:00:00Z"),
  };
  const start = new Date("2026-07-15T07:00:00Z");
  const end = new Date("2026-07-16T06:59:59.999Z");
  const selected = qaReviewDateForBasis(review, "evaluated");
  assert.ok(selected >= start && selected <= end);
  assert.ok(qaReviewDateForBasis(review, "call") < start);
});

test("QA dateBasis defaults to evaluated and explicitly supports call date", () => {
  assert.equal(parseQaDateBasis(undefined), "evaluated");
  assert.equal(parseQaDateBasis("evaluated"), "evaluated");
  assert.equal(parseQaDateBasis("call"), "call");
  assert.equal(parseQaDateBasis("created"), null);
});

test("QA routes consistently select evaluatedAt or callDate", async () => {
  const source = await routeSource("qa.ts");
  assert.match(source, /dateBasis === "evaluated" \? qaReviewsTable\.evaluatedAt : qaReviewsTable\.callDate/);
  for (const route of ["stats", "download", "reviews", "agents"]) {
    const start = source.indexOf(`router.get("/qa/${route}"`);
    assert.ok(start > 0, route);
    assert.match(source.slice(start, start + 2_500), /parseQaDateBasis\(req\.query\["dateBasis"\]\)/, route);
  }
});

test("QA run response includes the run ID and all three result collections", async () => {
  const source = await routeSource("qa.ts");
  assert.match(source, /interface QaBiweeklyResult[\s\S]*runId: number;[\s\S]*evaluated:[\s\S]*skipped:[\s\S]*errors:/);
  assert.match(source, /result: QaBiweeklyResult = \{ runId: run\?\.id \?\? 0, evaluated: \[\], skipped: \[\], errors: \[\] \}/);
});

test("QA frontend checks non-200 responses, displays results, and immediately invalidates every QA prefix", async () => {
  const source = await dashboardSource();
  const start = source.indexOf("const runProcessor = useCallback");
  const section = source.slice(start, start + 3_200);
  assert.match(section, /const body = await response\.json/);
  assert.match(section, /if \(!response\.ok\) throw new Error/);
  for (const key of ["qa-stats", "qa-reviews", "qa-tasks", "qa-agents", "qa-runs"]) {
    assert.match(section, new RegExp(`queryKey: \\["${key}"\\]`), key);
  }
  assert.match(source, /QA run #\{runResult\.runId\} completed/);
  assert.match(source, /Show run details/);
});

test("QA evaluation uses forced strict Anthropic tool output and validates before persistence", async () => {
  const source = await routeSource("qa.ts");
  const schema = qaEvaluationToolInputSchema("CS");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("managerReviewRequired"));
  assert.equal(schema.properties.categoryScores.additionalProperties, false);
  assert.ok(validateQaResult(validCsEvaluation, "CS"));
  assert.match(source, /createAnthropicToolMessage/);
  assert.match(source, /name: "record_qa_evaluation"/);
  assert.match(source, /toolInput\(completion, "record_qa_evaluation"\)/);
  assert.ok(source.indexOf("validateQaResultWithReason") < source.indexOf("db.insert(qaReviewsTable)"));
});

test("invalid strict QA output is rejected and sanitized without transcript logging", async () => {
  assert.equal(validateQaResult({ ...validCsEvaluation, categoryScores: { raw: 100 } }, "CS"), null);
  const source = await routeSource("qa.ts");
  assert.match(source, /validationReason:/);
  assert.doesNotMatch(source.slice(source.indexOf("validationReason:"), source.indexOf("return null", source.indexOf("validationReason:"))), /transcript/);
});

test("manager queue reports open all-time and created-in-range totals separately", async () => {
  const api = await routeSource("qa.ts");
  const ui = await dashboardSource();
  assert.match(api, /openManagerQueue/);
  assert.match(api, /managerTasksCreatedInRange/);
  assert.match(ui, /Open manager queue/);
  assert.match(ui, /Manager tasks today/);
  assert.doesNotMatch(ui.slice(ui.indexOf("interface QAStats"), ui.indexOf("interface QAReview")), /pendingReviews/);
});

test("known attendance and QA commands enter deterministic action intent", () => {
  const cases = [
    "Mark Ahmed off tomorrow",
    "Put Nora on PTO Friday",
    "Change Ryan to late today",
    "Mark Michael absent on July 18",
    "Add “doctor appointment” to Nora’s attendance note",
    "Correct Jacob's attendance to in",
  ];
  for (const message of cases) assert.match(detectSamiaOperationalIntent(message)?.kind ?? "", /^attendance_/, message);
  assert.equal(detectSamiaOperationalIntent("Run QA now")?.kind, "qa_run");
  assert.equal(detectSamiaOperationalIntent("Start a QA run")?.kind, "qa_run");
  assert.equal(detectSamiaOperationalIntent("Re-run QA for this call ID AC1234567890abcdef")?.kind, "qa_evaluate_call");
  assert.equal(detectSamiaOperationalIntent("Resolve this manager QA task AC1234567890abcdef")?.kind, "qa_resolve_task");
});

test("relative attendance dates use America/Los_Angeles and return an exact date", () => {
  assert.equal(ATTENDANCE_TIMEZONE, "America/Los_Angeles");
  assert.deepEqual(resolveAttendanceDate("tomorrow", new Date("2026-07-15T16:00:00Z")), { kind: "resolved", date: "2026-07-16" });
  assert.deepEqual(resolveAttendanceDate("Friday", new Date("2026-07-15T16:00:00Z")), { kind: "resolved", date: "2026-07-17" });
});

test("attendance member resolution supports unique, ambiguous, alias, and missing outcomes", () => {
  const ambiguousMembers = [{ id: 1, name: "Ahmed Ayman" }, { id: 2, name: "Ahmed Nasser" }];
  assert.equal(resolveAttendanceMember("Ahmed Ayman", ambiguousMembers).kind, "unique");
  assert.equal(resolveAttendanceMember("Ahmed", ambiguousMembers).kind, "ambiguous");
  assert.equal(resolveAttendanceMember("Nobody Here", ambiguousMembers).kind, "missing");
  const alias = resolveAttendanceMember("Ahmed Ayman", [{ id: 7, name: "Levi Miller" }]);
  assert.equal(alias.kind, "unique");
  if (alias.kind === "unique") assert.equal(alias.member.id, 7);
});

test("attendance conflict policy requires confirmation unless replacement language is explicit", () => {
  const mark = detectSamiaOperationalIntent("Mark Ahmed off tomorrow");
  const change = detectSamiaOperationalIntent("Change Ahmed to PTO tomorrow");
  assert.equal(mark?.kind, "attendance_set");
  assert.equal(change?.kind, "attendance_set");
  if (mark?.kind === "attendance_set") assert.equal(mark.overwrite, false);
  if (change?.kind === "attendance_set") assert.equal(change.overwrite, true);
});

test("attendance writes are read back before success and return mutation metadata", async () => {
  const service = await readFile(path.join(libDir, "attendanceService.ts"), "utf8");
  const samia = await routeSource("samia.ts");
  assert.ok(service.indexOf("const persisted = await getAttendanceRecord") > service.indexOf("onConflictDoUpdate"));
  assert.match(service, /Attendance persistence verification failed/);
  assert.match(samia, /resource: "attendance"/);
  assert.match(samia, /memberId: write\.member\.id/);
  assert.match(samia, /invalidateQueryKeys/);
  assert.ok(samia.indexOf("const reply = `Done.") > samia.indexOf("if (write.kind !== \"saved\")"));
});

test("attendance mutation routes enforce edit_attendance or manage_members", async () => {
  const source = await routeSource("attendance.ts");
  for (const route of [
    'post("/attendance/set"', 'put("/attendance/record"', 'post("/attendance/auto-mark"',
  ]) assert.match(source.slice(source.indexOf(`router.${route}`), source.indexOf(`router.${route}`) + 180), /requireAuth, requirePermission\("edit_attendance"\)/, route);
  for (const route of ['post("/attendance/members"', 'patch("/attendance/members/:id"', 'post("/attendance/import"']) {
    assert.match(source.slice(source.indexOf(`router.${route}`), source.indexOf(`router.${route}`) + 190), /requireAuth, requirePermission\("manage_members"\)/, route);
  }
});

test("Samia registry defines every required capability with strict schemas, authorization, and auditing metadata", () => {
  const required = [
    "attendance_lookup_members", "attendance_get_record", "attendance_set_record", "attendance_set_note", "attendance_auto_mark",
    "qa_run", "qa_evaluate_call", "qa_get_run_status", "qa_resolve_manager_task",
    "call_analysis", "number_lookup", "agent_contacts", "dashboard_statistics",
  ] as const;
  for (const name of required) {
    const definition = SAMIA_CAPABILITY_REGISTRY[name];
    assert.equal(definition.name, name);
    assert.equal(definition.strictInputSchema.additionalProperties, false);
    assert.ok(definition.executor);
    assert.ok(definition.classification === "read" || definition.auditBehavior === "write-attempt");
    assert.equal(typeof definition.confirmationRequired, "boolean");
  }
  assert.equal(SAMIA_CAPABILITY_REGISTRY.attendance_set_record.requiredPermission, "edit_attendance");
  assert.equal(SAMIA_CAPABILITY_REGISTRY.qa_run.requiredRole, "admin");
});

test("unregistered capabilities, raw SQL, and route control fields are rejected", async () => {
  assert.equal(hasForbiddenCapabilityInput({ sql: "select * from users" }), true);
  assert.equal(hasForbiddenCapabilityInput({ route: "/api/admin" }), true);
  assert.equal(hasForbiddenCapabilityInput({ table: "portal_users" }), true);
  assert.equal(hasForbiddenCapabilityInput({ number: "8508120151" }), false);
  await assert.rejects(executeSamiaCapability("raw_sql", {}, {
    user: { userId: 1, username: "admin", role: "admin", permissions: ["edit_attendance"] },
    executors: {},
  }), /not registered/);
});

test("Samia QA action uses the shared service route and returns all QA invalidations", async () => {
  const source = await routeSource("samia.ts");
  assert.match(source, /internalFetch\(req, "\/api\/qa\/process", \{ method: "POST" \}\)/);
  assert.match(source, /QA run #\$\{body\.runId/);
  assert.deepEqual(SAMIA_CAPABILITY_REGISTRY.qa_run.invalidateQueryKeys, ["qa-stats", "qa-reviews", "qa-tasks", "qa-agents", "qa-runs"]);
});

test("Samia frontend invalidates stable prefixes and emits dashboard:data-changed", async () => {
  const source = await dashboardSource();
  const start = source.indexOf("interface SamiaResponse");
  const end = source.indexOf("return (", source.indexOf("async function send", start));
  const section = source.slice(start, end);
  assert.match(section, /invalidateQueryKeys/);
  assert.match(section, /invalidateQueries\(\{ queryKey: \[key\], refetchType: "active" \}\)/);
  assert.match(section, /dashboard:data-changed/);
  assert.doesNotMatch(section, /queryKey: \["attendance", .*date/);
});

test("intermediate tool calls are hidden and opening Samia makes no Anthropic request", async () => {
  const api = await routeSource("samia.ts");
  const ui = await dashboardSource();
  assert.match(api, /safeVisibleSamiaReply\(finalReply\)/);
  assert.match(api, /toolResultMessage\(toolResults\)/);
  const openSection = ui.slice(ui.indexOf("function SamiaChat()"), ui.indexOf("async function send()", ui.indexOf("function SamiaChat()")));
  assert.doesNotMatch(openSection, /\/api\/samia\/chat/);
  assert.doesNotMatch(openSection, /Anthropic/);
});

test("dashboard attendance dates and API descriptions use the canonical LA timezone", async () => {
  const attendance = await routeSource("attendance.ts");
  const samia = await routeSource("samia.ts");
  const ui = await dashboardSource();
  assert.match(attendance, /ATTENDANCE_TIMEZONE/);
  assert.match(ui, /const todayStr = ltLaToday\(\)/);
  assert.match(ui, /const tomorrowStr = nextCalendarDate\(todayStr\)/);
  const prompt = samia.slice(samia.indexOf("## Attendance actions"), samia.indexOf("## Phone contact lookup"));
  assert.doesNotMatch(prompt, /Egypt|ALWAYS REFUSE/);
  assert.match(prompt, /America\/Los_Angeles/);
});

test("successful and failed Samia writes are audited without secrets or transcripts", async () => {
  const source = await readFile(path.join(libDir, "samiaCapabilities.ts"), "utf8");
  const audit = await readFile(path.join(libDir, "actionAudit.ts"), "utf8");
  assert.match(source, /success: result\.ok/);
  assert.match(source, /success: false/);
  assert.match(source, /instructionRef/);
  assert.doesNotMatch(audit, /Authorization|API_KEY|transcript/i);
});
