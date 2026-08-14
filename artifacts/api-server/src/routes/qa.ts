import { Router, type IRouter, type Response } from "express";
import type Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import { db, phoneCallsTable, qaReviewsTable, managerQaTasksTable, teamAgentsTable, qaBiweeklyRunsTable } from "@workspace/db";
import { and, desc, eq, gt, gte, lte, sql, inArray, type SQL } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { canonicalAgentName } from "../integrations/quo/sync.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { anthropicErrorStatus, createAnthropicToolMessage, toolInput, usageFields } from "../lib/anthropic.js";
import { AI_UNTRUSTED_DATA_SYSTEM_POLICY, wrapUntrustedAiData } from "../lib/aiPrivacy.js";
import { AiRateLimitError, withDatabaseLease, withDurableAiLimit } from "../lib/aiRateLimit.js";
import { getQuoCallArtifacts, isSafeQuoCallId, type QuoCallArtifacts } from "../lib/quoCall.js";
import {
  qaEvaluationToolInputSchema,
  parseQaDateBasis,
  shouldReuseStoredReview,
  stableEligibleCalls,
  validateQaResultWithReason,
} from "../lib/qaPolicy.js";
import { setPrivateDownloadHeaders } from "../lib/sensitiveWorkflowPolicy.js";
import { validateIntegrationDateRange } from "../lib/externalIntegrationPolicy.js";
import type { AuthPayload } from "../middleware/authCore.js";
import {
  isAdministrator,
  isCanonicalUser,
  metricTeamsForUser,
  normalizeAgentIdentity,
} from "../middleware/authorizationCore.js";
import { canAccessMetricAgent, loadAuthorizationAgentDirectory } from "../lib/authorizationScope.js";
import { planWeeklyQaAssignments } from "../lib/databasePerformance.js";
import { postgresBackgroundJobStore } from "../lib/backgroundJobStore.js";
import { manualJobKey, runNextBackgroundJob, scheduledJobKey } from "../lib/durableBackgroundJobs.js";
import { validCronAuthorization } from "../lib/cronAuth.js";
import { OPERATIONAL_CONFIG } from "../lib/operationalConfig.js";
import { addCalendarDays, calendarDateParts, formatCalendarDate, startOfBusinessDay } from "../lib/businessTime.js";
import {
  completeAiReservation,
  failAiReservation,
  hashAiIdempotencyKey,
  hashAiRequest,
  normalizeQaAgentKey,
  QA_ROLLING_INTERVAL_DAYS,
  reserveQaAgentRun,
  type QaReservationDecision,
} from "../lib/aiRequestReservations.js";

const router: IRouter = Router();

const QA_MODEL = OPERATIONAL_CONFIG.aiModels.qa;
const QA_REVIEW_INTERVAL_DAYS = QA_ROLLING_INTERVAL_DAYS;
const QA_MIN_CALL_SECONDS = Math.max(30, Number(process.env["QA_MIN_CALL_SECONDS"] ?? 90) || 90);

// ── Departments ─────────────────────────────────────────────────────────────
export type Department = "Retention" | "CS" | "NSF";
const DEPARTMENTS: Department[] = ["Retention", "CS", "NSF"];

function lineTeamToDepartment(lineTeam: string): Department | null {
  switch ((lineTeam || "").toLowerCase()) {
    case "retention": return "Retention";
    case "cs":        return "CS";
    case "nsf":       return "NSF";
    default:          return null;
  }
}

// ── Department-specific rubrics (added to a shared universal preamble) ──────
const UNIVERSAL_PREAMBLE = `You are a strict but fair AI Quality Assurance evaluator for a financial services call center.

You will be given a phone-call transcript between an AGENT and a CUSTOMER, plus context (line/team, direction, duration, AI summary). Score the AGENT against the department-specific scorecard below.

Every call is also evaluated on these UNIVERSAL soft-skill categories. Combine them with the department rubric to produce the final score.

UNIVERSAL CATEGORIES (subset of softSkillsScore):
- greeting:      proper, professional greeting; agent identifies self + company
- empathy:       acknowledges customer's situation/frustration
- ownership:     takes responsibility; does not blame other depts/systems
- listening:     responds to what the customer actually said
- communication: clear, accurate, jargon-free
- compliance:    follows verification + disclosure requirements
- problemResolution: actually solves or routes the problem
- callControl:   keeps the call on-track and on-pace
- professionalism: tone, language, no rudeness
- closing:       recap, next steps, polite close

OUTPUT — submit the complete evaluation through the record_qa_evaluation tool.

Hard rules:
- score MUST equal the sum of values in categoryScores.
- pass = (score >= 80) AND (criticalFail == false).
- managerReviewRequired = criticalFail OR score < 80 OR protocolScore < 70.
- Be concise. Be honest. Penalize transfers without attempt, missing process steps, rude tone.
`;

const DEPT_RUBRICS: Record<Department, string> = {
  Retention: `DEPARTMENT: Retention
SCORECARD (max 100, you choose how to split across these categories; weight them as listed):
- greeting (8), empathy (10), ownership (5), professionalism (5), closing (7)        ← softSkillsScore = sum of these
- pulledCustomerInfo (5)         ← did the agent pull/verify customer info up front?
- askedCancellationReason (10)
- usedRetentionFramework (15)    ← feel/felt/found, value-stack, reframe, dig-deeper
- attemptedSave (15)              ← clear, deliberate retention attempt — not just "ok"
- handledObjection (8)
- offeredSolution (7)              ← discount/plan change/concession when appropriate
- followedRetentionProcess (5)    ← documented properly, correct disposition
                                     (last 6 = protocolScore)

CRITICAL FAILS (criticalFail=true, pass=false):
- No retention attempt at all
- Customer explicitly asked to cancel and agent immediately cancelled without save attempt
- Agent ignored or talked over the cancellation concern
- Rude/dismissive/hostile behavior
- Major protocol violation (e.g. unauthorized cancellation, false promises)`,

  CS: `DEPARTMENT: Customer Support (CS)
SCORECARD (max 100):
- greeting (7), empathy (10), ownership (10), professionalism (5), closing (8)         ← softSkillsScore
- attemptedResolution (15)       ← tried to solve before transferring/escalating
- avoidedUnnecessaryTransfer (10) ← only transferred when truly needed
- handledCancellationConcerns (10) ← if customer hinted at cancel, addressed it first
- properWarmTransfer (5)         ← introduced customer to next agent if transferred
- accurateCallbackExpectations (5) ← gave correct timeframe / next steps
- accurateInformation (10)
- followedSupportWorkflow (5)
                                     (last 7 = protocolScore)

CRITICAL FAILS:
- Immediate transfer with no resolution attempt
- Cold transfer when warm was required
- Failure to explain next steps on an unresolved issue
- Incorrect escalation path (wrong team)
- Rude or dismissive behavior`,

  NSF: `DEPARTMENT: NSF (Non-Sufficient Funds / Payment Recovery)
SCORECARD (max 100):
- greeting (5), empathy (10), ownership (8), professionalism (5), closing (7)         ← softSkillsScore
- reviewedAccountStatus (10)     ← pulled NSF/account info up front
- explainedPaymentIssue (10)
- attemptedResolution (15)       ← payment method update, payment plan, retry
- attemptedSaveBeforeTransfer (10) ← did not transfer until save attempted
- collectedRequiredInfo (5)
- properWarmTransfer (5)
- verifiedDocumentation (5)
- loggedProperNotes (5)
                                     (last 8 = protocolScore)

CRITICAL FAILS:
- Failed to address the NSF/payment issue at all
- Transferred without any save/resolution attempt
- Missing critical documentation discussion (e.g. payment authorization)
- Rude or hostile to a financially-distressed customer`,
};

function buildSystemPrompt(dept: Department): string {
  return `${UNIVERSAL_PREAMBLE}\n${AI_UNTRUSTED_DATA_SYSTEM_POLICY}\n${DEPT_RUBRICS[dept]}`;
}


// ── OpenPhone fetch helpers ─────────────────────────────────────────────────
async function getTranscriptAndSummary(callId: string): Promise<{
  transcript: string;
  summary: string;
  nextSteps: string;
  artifacts: QuoCallArtifacts;
} | null> {
  const artifacts = await getQuoCallArtifacts(callId);
  if (artifacts.status !== "ready") return null;
  return {
    transcript: artifacts.transcriptText,
    summary: artifacts.summary.join(" "),
    nextSteps: artifacts.nextSteps.join("; "),
    artifacts,
  };
}

// ── Core evaluation ─────────────────────────────────────────────────────────
async function evaluateCall(callId: string, opts?: {
  source?: "auto_biweekly" | "manual_call_id";
  userId?: number;
  artifacts?: QuoCallArtifacts;
}): Promise<typeof qaReviewsTable.$inferSelect | null> {
  const [call] = await db.select().from(phoneCallsTable).where(eq(phoneCallsTable.id, callId)).limit(1);
  if (!call) return null;
  if (call.status !== "completed") return null;
  if ((opts?.source ?? "auto_biweekly") === "auto_biweekly" && (call.durationSeconds ?? 0) < QA_MIN_CALL_SECONDS) return null;

  // Department detection: start from line classification (already retention/cs/nsf/other)
  const initialDept = lineTeamToDepartment(call.lineTeam);
  if (!initialDept) return null; // skip "other" lines — not a tracked department

  const td = opts?.artifacts?.status === "ready"
    ? {
        transcript: opts.artifacts.transcriptText,
        summary: opts.artifacts.summary.join(" "),
        nextSteps: opts.artifacts.nextSteps.join("; "),
        artifacts: opts.artifacts,
      }
    : await getTranscriptAndSummary(callId);
  if (!td) return null;

  if ((opts?.source ?? "auto_biweekly") === "auto_biweekly") {
    const [existingReview] = await db.select({ id: qaReviewsTable.id })
      .from(qaReviewsTable).where(eq(qaReviewsTable.id, callId)).limit(1);
    if (existingReview) return null;
  }

  // Truncate very long transcripts
  const transcript = td.transcript.length > 16000 ? td.transcript.slice(0, 16000) + "\n[...truncated]" : td.transcript;

  const agentName = canonicalAgentName(call.agentName) ?? "Unknown";

  let completion;
  try {
    const tool: Anthropic.Tool = {
      name: "record_qa_evaluation",
      description: "Record the complete validated QA scorecard for this call.",
      input_schema: qaEvaluationToolInputSchema(initialDept),
    };
    completion = await createAnthropicToolMessage({
      model: QA_MODEL,
      maxTokens: 900,
      system: buildSystemPrompt(initialDept),
      prompt: `Agent identity: [AUTHORIZED_EMPLOYEE]\nLine-classified department: ${initialDept}\nDirection: ${call.direction}\nDuration: ${call.durationSeconds}s\n\n${wrapUntrustedAiData("quo_summary", `Summary: ${td.summary || "(none)"}\nNext steps: ${td.nextSteps || "(none)"}`, 4_000)}\n\n${wrapUntrustedAiData("quo_transcript", transcript, 16_000)}`,
      tool,
    });
    logger.info({
      feature: "qa",
      userId: opts?.userId ?? 0,
      model: completion.model,
      requestId: completion._request_id,
      success: true,
      ...usageFields(completion.usage),
    }, "anthropic request complete");
  } catch (error) {
    logger.warn({
      feature: "qa",
      userId: opts?.userId ?? 0,
      model: QA_MODEL,
      requestId: (error as { request_id?: unknown })?.request_id ?? null,
      success: false,
    }, "anthropic request failed");
    throw error;
  }

  const decoded = toolInput(completion, "record_qa_evaluation");
  const validation = validateQaResultWithReason(decoded, initialDept);
  const parsed = validation.result;
  if (!parsed) {
    logger.warn({
      feature: "qa",
      userId: opts?.userId ?? 0,
      model: QA_MODEL,
      success: false,
      validationReason: validation.reason ?? "record_qa_evaluation tool input was missing",
    }, "qa result validation failed");
    return null;
  }

  // Department: trust model if it returned a valid value; else fall back to line.
  const detectedDept: Department = (() => {
    const d = String(parsed.department ?? "").trim();
    if (DEPARTMENTS.includes(d as Department)) return d as Department;
    return initialDept;
  })();

  const categoryScores = parsed.categoryScores ?? {};
  const computedScore = Object.values(categoryScores).reduce((a, b) => a + (Number(b) || 0), 0);
  const score = Math.max(0, Math.min(100, Math.round(parsed.score ?? computedScore)));
  const softSkillsScore = Math.max(0, Math.min(100, Math.round(parsed.softSkillsScore ?? 0)));
  const protocolScore = Math.max(0, Math.min(100, Math.round(parsed.protocolScore ?? 0)));
  const criticalFail = Boolean(parsed.criticalFail);
  const pass = !criticalFail && score >= 80;
  const managerReviewRequired = criticalFail || score < 80 || protocolScore < 70;

  const reviewRow = {
    id: callId,
    agentName,
    phoneNumber: call.participant,
    callDate: call.createdAt,
    lineTeam: call.lineTeam,
    department: detectedDept,
    transcript: transcript.slice(0, 8000),
    aiSummary: td.summary || null,
    score,
    softSkillsScore,
    protocolScore,
    pass,
    criticalFail,
    strengths: parsed.strengths,
    missedItems: parsed.missedItems,
    criticalIssues: parsed.criticalIssues,
    categoryScores,
    reason: parsed.reason ?? null,
    managerReviewRequired,
    model: QA_MODEL,
    source: opts?.source ?? "auto_biweekly",
  } satisfies typeof qaReviewsTable.$inferInsert;

  await db.insert(qaReviewsTable).values(reviewRow).onConflictDoUpdate({
    target: qaReviewsTable.id,
    set: {
      department: reviewRow.department,
      score: reviewRow.score,
      softSkillsScore: reviewRow.softSkillsScore,
      protocolScore: reviewRow.protocolScore,
      pass: reviewRow.pass,
      criticalFail: reviewRow.criticalFail,
      strengths: reviewRow.strengths,
      missedItems: reviewRow.missedItems,
      criticalIssues: reviewRow.criticalIssues,
      categoryScores: reviewRow.categoryScores,
      reason: reviewRow.reason,
      managerReviewRequired: reviewRow.managerReviewRequired,
      model: reviewRow.model,
      source: reviewRow.source,
      evaluatedAt: new Date(),
    },
  });

  if (managerReviewRequired) {
    const taskReason =
      parsed.reason
      ?? (criticalFail ? "Critical fail" : protocolScore < 70 ? "Protocol compliance < 70" : "Score below 80");
    await db.insert(managerQaTasksTable).values({
      id: callId,
      agentName,
      department: detectedDept,
      aiScore: score,
      score,
      reason: taskReason,
      criticalFail,
      source: opts?.source ?? "auto_biweekly",
      status: "open",
    }).onConflictDoNothing();
  }

  const [saved] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, callId)).limit(1);
  return saved ?? null;
}

// ── Background processor (all 3 departments) ────────────────────────────────
export interface QaBiweeklyResult {
  runId: number;
  evaluated: Array<{ agent: string; callId: string }>;
  skipped: Array<{ agent: string; reason: string }>;
  errors: Array<{ agent: string; reason: string }>;
}

function agentKey(value: string | null | undefined): string {
  return normalizeQaAgentKey(canonicalAgentName(value) ?? value ?? "");
}

function qaReservationReason(decision: Exclude<QaReservationDecision, { kind: "reserved" }>): string {
  if (decision.kind === "completed" || decision.kind === "cooldown") {
    return `QA already completed within the rolling ${QA_REVIEW_INTERVAL_DAYS}-day window`;
  }
  if (decision.kind === "in_progress") return "QA is already reserved for this agent";
  return "QA idempotency key conflicts with another request";
}

export async function runBiweeklyQa(
  trigger: "cron" | "admin",
  signal?: AbortSignal,
): Promise<QaBiweeklyResult> {
  return withDatabaseLease("qa_auto_biweekly", async () => {
    signal?.throwIfAborted();
    const [run] = await db.insert(qaBiweeklyRunsTable).values({ trigger }).returning({ id: qaBiweeklyRunsTable.id });
    const result: QaBiweeklyResult = { runId: run?.id ?? 0, evaluated: [], skipped: [], errors: [] };
    try {
      const cutoff = new Date(Date.now() - QA_REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
      const [roster, recentReviews, candidates, reviewed] = await Promise.all([
        db.select().from(teamAgentsTable).where(and(
          eq(teamAgentsTable.active, true),
          inArray(teamAgentsTable.team, ["retention", "cs", "nsf"]),
        )),
        db.select({ agentName: qaReviewsTable.agentName }).from(qaReviewsTable)
          .where(gt(qaReviewsTable.evaluatedAt, cutoff)),
        db.select().from(phoneCallsTable).where(and(
          gte(phoneCallsTable.createdAt, cutoff),
          eq(phoneCallsTable.status, "completed"),
          gte(phoneCallsTable.durationSeconds, QA_MIN_CALL_SECONDS),
          inArray(phoneCallsTable.lineTeam, ["retention", "cs", "nsf"]),
        )),
        db.select({ id: qaReviewsTable.id }).from(qaReviewsTable).where(gte(qaReviewsTable.callDate, cutoff)),
      ]);

      const recentlyReviewed = new Set(recentReviews.map((row) => agentKey(row.agentName)));
      const reviewedCalls = new Set(reviewed.map((row) => row.id));
      const sortedCandidates = stableEligibleCalls(candidates, reviewedCalls, QA_MIN_CALL_SECONDS);

      for (const rosterAgent of [...roster].sort((a, b) => a.name.localeCompare(b.name))) {
        signal?.throwIfAborted();
        const key = agentKey(rosterAgent.name);
        if (recentlyReviewed.has(key)) {
          result.skipped.push({ agent: rosterAgent.name, reason: `QA review already exists within ${QA_REVIEW_INTERVAL_DAYS} days` });
          continue;
        }

        const agentCandidates = sortedCandidates.filter((call) => agentKey(call.agentName) === key);
        if (agentCandidates.length === 0) {
          result.skipped.push({ agent: rosterAgent.name, reason: `no unreviewed completed call of at least ${QA_MIN_CALL_SECONDS} seconds` });
          continue;
        }

        let selected: (typeof agentCandidates)[number] | null = null;
        let artifacts: QuoCallArtifacts | null = null;
        for (const candidate of agentCandidates) {
          signal?.throwIfAborted();
          const candidateArtifacts = await getQuoCallArtifacts(candidate.id);
          if (candidateArtifacts.status === "ready") {
            selected = candidate;
            artifacts = candidateArtifacts;
            break;
          }
        }
        if (!selected || !artifacts) {
          result.skipped.push({ agent: rosterAgent.name, reason: "no eligible call has a real QUO transcript" });
          continue;
        }

        const reservation = await reserveQaAgentRun({
          agentKey: key,
          agentName: rosterAgent.name,
          callId: selected.id,
          idempotencyKey: hashAiIdempotencyKey(`qa-call:${selected.id}`),
          requestHash: hashAiRequest({ callId: selected.id }),
          source: "auto_biweekly",
          requestedByUserId: null,
        });
        if (reservation.kind !== "reserved") {
          result.skipped.push({ agent: rosterAgent.name, reason: qaReservationReason(reservation) });
          continue;
        }

        try {
          const review = await evaluateCall(selected.id, {
            source: "auto_biweekly",
            userId: 0,
            artifacts,
          });
          if (review) {
            await completeAiReservation(
              reservation.id,
              200,
              { callId: selected.id },
              QA_REVIEW_INTERVAL_DAYS * 24 * 60 * 60,
            );
            result.evaluated.push({ agent: rosterAgent.name, callId: selected.id });
            recentlyReviewed.add(key);
          } else {
            await failAiReservation(reservation.id, "QA_RESULT_INVALID");
            result.skipped.push({ agent: rosterAgent.name, reason: "Claude result failed server-side validation" });
          }
        } catch (error) {
          await failAiReservation(reservation.id, "QA_EVALUATION_FAILED").catch(() => undefined);
          result.errors.push({ agent: rosterAgent.name, reason: `evaluation failed (${anthropicErrorStatus(error) ?? "internal"})` });
        }
      }

      if (run) {
        await db.update(qaBiweeklyRunsTable).set({
          status: "completed",
          result: { ...result },
          finishedAt: new Date(),
        })
          .where(eq(qaBiweeklyRunsTable.id, run.id));
      }
      return result;
    } catch (error) {
      if (run) {
        await db.update(qaBiweeklyRunsTable).set({
          status: "failed",
          result: { ...result },
          finishedAt: new Date(),
        }).where(eq(qaBiweeklyRunsTable.id, run.id)).catch(() => undefined);
      }
      throw error;
    }
  });
}

// ── Weekly auto-assignment: 1 lowest + 1 random per agent ───────────────────
// Runs every Monday. Idempotent per week.
// Compute Monday 00:00 of the current LA week (in UTC) for stable weekly window.
function currentLAWeekStart(): Date {
  const today = formatCalendarDate(new Date());
  const { year, month, day } = calendarDateParts(today);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMon = (dow + 6) % 7;
  return startOfBusinessDay(addCalendarDays(today, -daysSinceMon));
}

export async function runWeeklyAssignment(): Promise<{ created: number; agents: number }> {
  const weekStart = currentLAWeekStart();
  const lookback = startOfBusinessDay(addCalendarDays(formatCalendarDate(weekStart), -7));

  // Eligible reviews: from the prior week through now (so Monday-morning runs see last week's calls).
  const reviews = await db
    .select()
    .from(qaReviewsTable)
    .where(gte(qaReviewsTable.callDate, lookback));

  const agents = [...new Set(reviews.map((review) => review.agentName))];
  const existingTasks = agents.length > 0
    ? await db.select({
        id: managerQaTasksTable.id,
        agentName: managerQaTasksTable.agentName,
        source: managerQaTasksTable.source,
        createdAt: managerQaTasksTable.createdAt,
      }).from(managerQaTasksTable).where(inArray(managerQaTasksTable.agentName, agents))
    : [];
  const plan = planWeeklyQaAssignments(reviews, existingTasks, weekStart);
  const inserted = plan.picks.length > 0
    ? await db.insert(managerQaTasksTable)
        .values(plan.picks)
        .onConflictDoNothing()
        .returning({ id: managerQaTasksTable.id })
    : [];

  return { created: inserted.length, agents: plan.agents };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
type QaDepartmentScope =
  | { ok: true; departments: Department[] | null }
  | { ok: false; status: 400 | 403; error: string };

function deptFilterArr(req: { query: Record<string, unknown>; user?: AuthPayload }): QaDepartmentScope {
  const d = String(req.query["department"] ?? "").trim().toLowerCase();
  const map: Record<string, Department> = { retention: "Retention", cs: "CS", nsf: "NSF" };
  const requested = !d || d === "all" ? null : map[d];
  if (d && d !== "all" && !requested) return { ok: false, status: 400, error: "Invalid department." };

  if (req.user && isCanonicalUser(req.user)) {
    if (isAdministrator(req.user)) return { ok: true, departments: requested ? [requested] : null };
    const allowedTeams = metricTeamsForUser(req.user) ?? new Set();
    const teamForDepartment: Record<Department, "retention" | "cs" | "nsf"> = {
      Retention: "retention",
      CS: "cs",
      NSF: "nsf",
    };
    if (requested && !allowedTeams.has(teamForDepartment[requested])) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    const departments = requested
      ? [requested]
      : (Object.keys(teamForDepartment) as Department[]).filter((department) =>
          allowedTeams.has(teamForDepartment[department]));
    return { ok: true, departments };
  }

  const team = req.user?.role === "admin" ? null : req.user?.teamAccess;
  const allowed = team === "retention" ? "Retention" : team === "cs" ? "CS" : team === "nsf" ? "NSF" : null;
  if (team && !allowed) return { ok: false, status: 403, error: "Forbidden" };
  if (allowed && requested && requested !== allowed) return { ok: false, status: 403, error: "Forbidden" };
  return { ok: true, departments: requested ? [requested] : allowed ? [allowed] : null };
}

type QaAgentScope = {
  canAccess: (agentName: string) => boolean;
  predicateFor: (column: typeof qaReviewsTable.agentName | typeof managerQaTasksTable.agentName) => SQL | undefined;
};

async function qaAgentScope(user: AuthPayload): Promise<QaAgentScope> {
  if (isAdministrator(user) || (!isCanonicalUser(user) && !user.allowedAgents?.length)) {
    return { canAccess: () => true, predicateFor: () => undefined };
  }
  const directory = await loadAuthorizationAgentDirectory();
  const canAccess = (agentName: string) => {
    return canAccessMetricAgent(user, agentName, directory);
  };
  const authorizedIdentities = new Set(
    isCanonicalUser(user) ? [] : (user.allowedAgents ?? []).map(normalizeAgentIdentity).filter(Boolean),
  );
  for (const agent of directory.agents) {
    if (!canAccess(agent.name)) continue;
    authorizedIdentities.add(normalizeAgentIdentity(agent.name));
    if (agent.arabicName) authorizedIdentities.add(normalizeAgentIdentity(agent.arabicName));
  }
  const identities = [...authorizedIdentities].filter(Boolean);
  return {
    canAccess,
    predicateFor: (column) => inArray(
      sql<string>`regexp_replace(lower(trim(${column})), '[^a-z0-9]+', ' ', 'g')`,
      identities,
    ),
  };
}

function qaRequestDateRange(query: Record<string, unknown>): { ok: true; from: Date; to: Date } | { ok: false; error: string } {
  const rawFrom = query["from"] ? String(query["from"]) : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const rawTo = query["to"] ? String(query["to"]) : new Date().toISOString();
  const range = validateIntegrationDateRange(rawFrom, rawTo);
  return range.ok ? { ok: true, from: range.fromDate, to: range.toDate } : range;
}

function qaReviewDateColumn(dateBasis: "evaluated" | "call") {
  return dateBasis === "evaluated" ? qaReviewsTable.evaluatedAt : qaReviewsTable.callDate;
}

// POSIX word-boundary regex matching "tax" or "taxes" (case-insensitive) inside a
// transcript — used both for QA stats counts and the per-review export flag.
const TAX_REGEX = String.raw`\ytax(es)?\y`;

// ── Routes ──────────────────────────────────────────────────────────────────

router.post("/qa/evaluate", requireAuth, requireRole("admin"), async (req, res) => {
  let reservationId: number | null = null;
  try {
    const callId = typeof req.body?.callId === "string" ? req.body.callId.trim() : "";
    const force = req.body?.force === true;
    if (!isSafeQuoCallId(callId)) return res.status(400).json({ error: "A valid QUO callId is required" });
    const rawIdempotencyKey = req.get("idempotency-key")?.trim();
    if (rawIdempotencyKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(rawIdempotencyKey)) {
      return res.status(400).json({ error: "Idempotency-Key is invalid" });
    }

    const [existing] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, callId)).limit(1);
    if (shouldReuseStoredReview(existing, force)) return res.json(existing);

    const [[call], artifacts] = await Promise.all([
      db.select().from(phoneCallsTable).where(eq(phoneCallsTable.id, callId)).limit(1),
      getQuoCallArtifacts(callId),
    ]);
    if (!call && artifacts.status === "not_found") return res.status(404).json({ error: "Call not found" });
    if (!call) return res.status(404).json({ error: "Call metadata was not found in the synchronized QUO calls table" });
    if (artifacts.status !== "ready") {
      return res.status(409).json({ error: "QUO transcript is unavailable or still processing" });
    }

    const agentName = canonicalAgentName(call.agentName);
    const key = agentKey(agentName);
    if (!agentName || !key || key === "unknown") {
      return res.status(422).json({ error: "Call has no authoritative QA agent identity" });
    }
    const reservation = await reserveQaAgentRun({
      agentKey: key,
      agentName,
      callId,
      idempotencyKey: hashAiIdempotencyKey(rawIdempotencyKey || `qa-call:${callId}`),
      requestHash: hashAiRequest({ callId }),
      source: "manual_call_id",
      requestedByUserId: req.user!.userId,
    });
    if (reservation.kind === "completed") {
      const [completedReview] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, callId)).limit(1);
      return completedReview
        ? res.json(completedReview)
        : res.status(409).json({ error: "QA was already completed for this agent" });
    }
    if (reservation.kind === "in_progress") {
      res.setHeader("Retry-After", String(reservation.retryAfter));
      return res.status(409).json({ error: "QA is already processing for this agent" });
    }
    if (reservation.kind === "cooldown") {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((reservation.eligibleAt.getTime() - Date.now()) / 1_000))));
      return res.status(409).json({
        error: `QA is limited to one completed or reserved run per agent in any rolling ${QA_REVIEW_INTERVAL_DAYS}-day period`,
        eligibleAt: reservation.eligibleAt.toISOString(),
      });
    }
    if (reservation.kind === "conflict") {
      return res.status(409).json({ error: "Idempotency-Key was already used for a different QA request" });
    }
    reservationId = reservation.id;

    const review = await withDurableAiLimit({
      feature: "qa_manual",
      userId: req.user!.userId,
      perMinute: 3,
      perDay: 20,
    }, () => evaluateCall(callId, {
      source: "manual_call_id",
      userId: req.user!.userId,
      artifacts,
    }));
    if (!review) {
      await failAiReservation(reservationId, "QA_RESULT_INVALID");
      reservationId = null;
      return res.status(422).json({ error: "Call is not QA-eligible or Claude returned an invalid evaluation" });
    }
    await completeAiReservation(
      reservationId,
      200,
      { callId },
      QA_REVIEW_INTERVAL_DAYS * 24 * 60 * 60,
    );
    reservationId = null;
    return res.json(review);
  } catch (err) {
    if (reservationId !== null) {
      await failAiReservation(reservationId, "QA_EVALUATION_FAILED").catch(() => undefined);
    }
    if (err instanceof AiRateLimitError) {
      res.setHeader("Retry-After", String(err.retryAfter));
      return res.status(429).json({ error: "Manual QA evaluation limit reached" });
    }
    if ((err as Error)?.message?.includes("ANTHROPIC_API_KEY")) {
      return res.status(500).json({ error: "QA is missing server-side Anthropic configuration" });
    }
    return res.status(502).json({ error: "QA evaluation failed" });
  }
});

async function runBiweeklyResponse(res: Response, userId: number) {
  try {
    const result = await withDurableAiLimit(
      { feature: "qa_admin_run", userId, perMinute: 1, perDay: 10 },
      async () => {
        const enqueued = await postgresBackgroundJobStore.enqueue({
          jobType: "qa_biweekly",
          idempotencyKey: manualJobKey("qa_biweekly", userId),
          requestedByUserId: userId,
          priority: 100,
          maxAttempts: 3,
        });
        const workerId = `manual:qa:${userId}:${Date.now()}`;
        const run = await runNextBackgroundJob(postgresBackgroundJobStore, {
          qa_biweekly: async (_job, { signal }) => {
            signal.throwIfAborted();
            return { ...(await runBiweeklyQa("admin", signal)) };
          },
        }, {
          workerId,
          jobId: enqueued.job.id,
          leaseMs: 6 * 60_000,
          timeoutMs: 4 * 60_000,
          retryAfterMs: 60_000,
        });
        const stored = await postgresBackgroundJobStore.get(enqueued.job.id);
        if (stored?.status === "completed" && stored.result) return stored.result;
        if (run.outcome === "idle" || stored?.status === "running") throw new AiRateLimitError("lease", 60);
        throw new Error(stored?.lastErrorCode ?? "qa_job_failed");
      },
    );
    return res.json(result);
  } catch (err) {
    if (err instanceof AiRateLimitError) {
      res.setHeader("Retry-After", String(err.retryAfter));
      if (err.reason !== "lease") {
        return res.status(429).json({ error: "QA run limit reached" });
      }
      const [activeRun] = await db.select().from(qaBiweeklyRunsTable)
        .where(eq(qaBiweeklyRunsTable.status, "running"))
        .orderBy(desc(qaBiweeklyRunsTable.startedAt))
        .limit(1);
      return res.status(409).json({
        error: "A biweekly QA run is already active",
        activeRun: activeRun ?? null,
      });
    }
    return res.status(500).json({ error: "Biweekly QA run failed" });
  }
}

router.post("/qa/biweekly-run", requireAuth, requireRole("admin"), async (req, res) => {
  return runBiweeklyResponse(res, req.user!.userId);
});

// Backward-compatible admin button endpoint; it now runs the same idempotent
// biweekly check and ignores the former batchSize option.
router.post("/qa/process", requireAuth, requireRole("admin"), async (req, res) => {
  return runBiweeklyResponse(res, req.user!.userId);
});

router.get("/qa/runs/latest", requireAuth, requireRole("admin"), async (_req, res) => {
  const [run] = await db.select().from(qaBiweeklyRunsTable)
    .orderBy(desc(qaBiweeklyRunsTable.startedAt))
    .limit(1);
  return res.json({ run: run ?? null });
});

router.get("/qa/biweekly-run", async (req, res) => {
  const secret = process.env["CRON_SECRET"]?.trim();
  if (!secret || secret.length < 16) return res.status(503).json({ error: "CRON_SECRET is not configured" });
  if (!validCronAuthorization(req.get("authorization"), secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const enqueued = await postgresBackgroundJobStore.enqueue({
      jobType: "qa_biweekly",
      idempotencyKey: scheduledJobKey("qa_biweekly", day),
      priority: 30,
      maxAttempts: 3,
    });
    return res.json({ ok: true, queued: enqueued.created, jobId: enqueued.job.id });
  } catch (error) {
    req.log.error(error, "QA cron enqueue failed");
    return res.status(503).json({ error: "QA run could not be queued" });
  }
});

router.post("/qa/assign-weekly", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await runWeeklyAssignment();
    return res.json(r);
  } catch (err) {
    req.log.error(err, "qa weekly assign error");
    return res.status(500).json({ error: "Weekly QA assignment failed" });
  }
});

router.get("/qa/stats", requireAuth, async (req, res) => {
  try {
    const range = qaRequestDateRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const dateBasis = parseQaDateBasis(req.query["dateBasis"]);
    if (!dateBasis) return res.status(400).json({ error: "dateBasis must be evaluated or call" });
    const dateColumn = qaReviewDateColumn(dateBasis);

    const filters = [gte(dateColumn, from), lte(dateColumn, to)];
    if (depts) filters.push(inArray(qaReviewsTable.department, depts));

    const agentScope = await qaAgentScope(req.user!);
    const reviewAgentPredicate = agentScope.predicateFor(qaReviewsTable.agentName);
    if (reviewAgentPredicate) filters.push(reviewAgentPredicate);
    const queriedRows = await db
      .select({
        id: qaReviewsTable.id,
        agentName: qaReviewsTable.agentName,
        score: qaReviewsTable.score,
        softSkillsScore: qaReviewsTable.softSkillsScore,
        protocolScore: qaReviewsTable.protocolScore,
        pass: qaReviewsTable.pass,
        criticalFail: qaReviewsTable.criticalFail,
        managerReviewRequired: qaReviewsTable.managerReviewRequired,
        department: qaReviewsTable.department,
        mentionsTax: sql<boolean>`(${qaReviewsTable.transcript} ~* ${TAX_REGEX})`,
      })
      .from(qaReviewsTable)
      .where(and(...filters));
    const rows = queriedRows.filter((row) => agentScope.canAccess(row.agentName));

    const reviewed = rows.length;
    const avgScore = reviewed ? Math.round(rows.reduce((a, r) => a + r.score, 0) / reviewed) : 0;
    const avgProtocol = reviewed ? Math.round(rows.reduce((a, r) => a + (r.protocolScore || 0), 0) / reviewed) : 0;
    const avgSoftSkills = reviewed ? Math.round(rows.reduce((a, r) => a + (r.softSkillsScore || 0), 0) / reviewed) : 0;
    const failed = rows.filter((r) => !r.pass).length;
    const criticalFails = rows.filter((r) => r.criticalFail).length;

    // Per-department breakdown
    const byDept: Record<string, { reviewed: number; avgScore: number; criticalFails: number; failed: number; taxMentions: number }> = {};
    for (const r of rows) {
      const d = r.department || "Unknown";
      if (!byDept[d]) byDept[d] = { reviewed: 0, avgScore: 0, criticalFails: 0, failed: 0, taxMentions: 0 };
      byDept[d].reviewed++;
      byDept[d].avgScore += r.score;
      if (r.criticalFail) byDept[d].criticalFails++;
      if (!r.pass) byDept[d].failed++;
      if (r.mentionsTax) byDept[d].taxMentions++;
    }
    for (const d of Object.keys(byDept)) {
      const b = byDept[d];
      b.avgScore = b.reviewed ? Math.round(b.avgScore / b.reviewed) : 0;
    }

    const taxMentions = rows.filter((row) => row.mentionsTax).length;
    const taskFilters = depts ? [inArray(managerQaTasksTable.department, depts)] : [];
    const taskAgentPredicate = agentScope.predicateFor(managerQaTasksTable.agentName);
    if (taskAgentPredicate) taskFilters.push(taskAgentPredicate);
    const tasks = (await db.select({
      agentName: managerQaTasksTable.agentName,
      status: managerQaTasksTable.status,
      managerScore: managerQaTasksTable.managerScore,
      variance: managerQaTasksTable.variance,
      createdAt: managerQaTasksTable.createdAt,
    }).from(managerQaTasksTable).where(taskFilters.length ? and(...taskFilters) : undefined))
      .filter((task) => agentScope.canAccess(task.agentName));
    const openManagerQueue = tasks.filter((task) => task.status === "open").length;
    const managerTasksCreatedInRange = tasks.filter((task) => task.createdAt >= from && task.createdAt <= to).length;
    const variRows = tasks.filter((task) => task.status === "resolved"
      && task.managerScore !== null
      && task.createdAt >= from
      && task.createdAt <= to);
    const avgVariance = variRows.length
      ? Math.round((variRows.reduce((a, r) => a + Math.abs(r.variance ?? 0), 0) / variRows.length) * 10) / 10
      : 0;

    return res.json({
      reviewed, avgScore, avgProtocol, avgSoftSkills,
      failed, criticalFails,
      openManagerQueue,
      managerTasksCreatedInRange,
      avgVariance,
      taxMentions,
      byDept,
      dateBasis,
    });
  } catch (err) {
    req.log.error(err, "qa stats error");
    return res.status(500).json({ error: "Unable to load QA statistics." });
  }
});

// GET /api/qa/download — Excel export of QA reviews (with a Mentions Tax flag).
router.get("/qa/download", requireAuth, async (req, res) => {
  try {
    const range = qaRequestDateRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const dateBasis = parseQaDateBasis(req.query["dateBasis"]);
    if (!dateBasis) return res.status(400).json({ error: "dateBasis must be evaluated or call" });
    const dateColumn = qaReviewDateColumn(dateBasis);

    const filters = [gte(dateColumn, from), lte(dateColumn, to)];
    if (depts) filters.push(inArray(qaReviewsTable.department, depts));

    const agentScope = await qaAgentScope(req.user!);
    const agentPredicate = agentScope.predicateFor(qaReviewsTable.agentName);
    if (agentPredicate) filters.push(agentPredicate);
    const queriedRows = await db
      .select({
        evaluatedAt: qaReviewsTable.evaluatedAt,
        callDate: qaReviewsTable.callDate,
        agentName: qaReviewsTable.agentName,
        department: qaReviewsTable.department,
        phoneNumber: qaReviewsTable.phoneNumber,
        score: qaReviewsTable.score,
        protocolScore: qaReviewsTable.protocolScore,
        softSkillsScore: qaReviewsTable.softSkillsScore,
        pass: qaReviewsTable.pass,
        criticalFail: qaReviewsTable.criticalFail,
        aiSummary: qaReviewsTable.aiSummary,
        mentionsTax: sql<boolean>`(${qaReviewsTable.transcript} ~* ${TAX_REGEX})`,
      })
      .from(qaReviewsTable)
      .where(and(...filters))
      .orderBy(desc(dateColumn));
    const rows = queriedRows.filter((row) => agentScope.canAccess(row.agentName));

    const wb = new ExcelJS.Workbook();
    wb.creator = "Backend Tracker";
    wb.created = new Date();
    const TZ = "America/Los_Angeles";
    const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

    const ws = wb.addWorksheet("QA Reviews", {
      views: [{ state: "frozen", ySplit: 4 }],
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    const headers = [
      "Evaluated (Los Angeles)", "Call Date (Los Angeles)", "Agent", "Department", "Customer Phone",
      "Score", "Protocol", "Soft Skills", "Result", "Critical Fail", "Mentions Tax", "AI Summary",
    ];
    const widths = [22, 22, 22, 14, 16, 8, 10, 11, 10, 12, 13, 60];
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    const ncols = headers.length;

    ws.mergeCells(1, 1, 1, ncols);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = "QA Reviews — Tax Mentions Report";
    titleCell.font = { bold: true, size: 16, color: { argb: "FF3B0764" } };
    ws.mergeCells(2, 1, 2, ncols);
    const taxCount = rows.filter((r) => r.mentionsTax).length;
    ws.getCell(2, 1).value = `${rows.length} reviewed  •  ${taxCount} mention tax  •  Generated ${new Date().toLocaleString("en-US", { timeZone: TZ })} (LA)`;
    ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: "FF666666" } };

    const headerRow = ws.getRow(4);
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = solid("FF6D28D9");
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    headerRow.commit();

    let r = 5;
    for (const row of rows) {
      const xr = ws.getRow(r);
      xr.getCell(1).value = new Date(row.evaluatedAt).toLocaleString("en-US", { timeZone: TZ });
      xr.getCell(2).value = new Date(row.callDate).toLocaleString("en-US", { timeZone: TZ });
      xr.getCell(3).value = row.agentName ?? "";
      xr.getCell(4).value = row.department ?? "";
      xr.getCell(5).value = row.phoneNumber ?? "";
      xr.getCell(6).value = row.score ?? 0;
      xr.getCell(7).value = row.protocolScore ?? 0;
      xr.getCell(8).value = row.softSkillsScore ?? 0;
      xr.getCell(9).value = row.pass ? "Pass" : "Fail";
      xr.getCell(10).value = row.criticalFail ? "YES" : "";
      const taxCell = xr.getCell(11);
      taxCell.value = row.mentionsTax ? "YES" : "";
      taxCell.alignment = { horizontal: "center" };
      if (row.mentionsTax) {
        taxCell.fill = solid("FFFEF3C7");
        taxCell.font = { bold: true, color: { argb: "FF92400E" } };
      }
      xr.getCell(12).value = row.aiSummary ?? "";
      xr.commit();
      r++;
    }
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, r - 1), column: ncols } };

    setPrivateDownloadHeaders(res, "QA_Reviews.xlsx");
    await wb.xlsx.write(res);
    res.end();
    return;
  } catch (err) {
    req.log.error(err, "qa download error");
    res.status(500).json({ error: "Unable to generate QA export." });
    return;
  }
});

router.get("/qa/reviews", requireAuth, async (req, res) => {
  try {
    const range = qaRequestDateRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const agent = (req.query["agent"] as string) || "";
    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "100", 10) || 100, 500);
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const dateBasis = parseQaDateBasis(req.query["dateBasis"]);
    if (!dateBasis) return res.status(400).json({ error: "dateBasis must be evaluated or call" });
    const dateColumn = qaReviewDateColumn(dateBasis);

    const filters = [gte(dateColumn, from), lte(dateColumn, to)];
    if (agent) filters.push(sql`lower(${qaReviewsTable.agentName}) = ${agent.toLowerCase()}`);
    if (depts) filters.push(inArray(qaReviewsTable.department, depts));

    const agentScope = await qaAgentScope(req.user!);
    if (agent && !agentScope.canAccess(agent)) return res.status(403).json({ error: "Forbidden" });
    const agentPredicate = agentScope.predicateFor(qaReviewsTable.agentName);
    if (agentPredicate) filters.push(agentPredicate);
    const queriedRows = await db
      .select()
      .from(qaReviewsTable)
      .where(and(...filters))
      .orderBy(desc(dateColumn))
      .limit(limit);
    const rows = queriedRows.filter((row) => agentScope.canAccess(row.agentName));

    return res.json({ reviews: rows, dateBasis });
  } catch (err) {
    req.log.error(err, "qa reviews error");
    return res.status(500).json({ error: "Unable to load QA reviews." });
  }
});

router.get("/qa/reviews/:id", requireAuth, async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [row] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, id ?? "")).limit(1);
    if (!row) return res.status(404).json({ error: "not found" });
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    if (departmentScope.departments && !departmentScope.departments.includes(row.department as Department)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const agentScope = await qaAgentScope(req.user!);
    if (!agentScope.canAccess(row.agentName)) return res.status(403).json({ error: "Forbidden" });
    return res.json(row);
  } catch (err) {
    req.log.error(err, "qa review fetch error");
    return res.status(500).json({ error: "Unable to load QA review." });
  }
});

router.get("/qa/tasks", requireAuth, async (req, res) => {
  try {
    const status = (req.query["status"] as string) || "open";
    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "100", 10) || 100, 500);
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const statuses = status === "all" ? ["open", "resolved"] : [status];
    const filters: any[] = [inArray(managerQaTasksTable.status, statuses)];
    if (depts) filters.push(inArray(managerQaTasksTable.department, depts));

    const agentScope = await qaAgentScope(req.user!);
    const agentPredicate = agentScope.predicateFor(managerQaTasksTable.agentName);
    if (agentPredicate) filters.push(agentPredicate);
    const queriedRows = await db
      .select()
      .from(managerQaTasksTable)
      .where(and(...filters))
      .orderBy(desc(managerQaTasksTable.createdAt))
      .limit(limit);
    const rows = queriedRows.filter((row) => agentScope.canAccess(row.agentName));
    return res.json({ tasks: rows });
  } catch (err) {
    req.log.error(err, "qa tasks error");
    return res.status(500).json({ error: "Unable to load QA tasks." });
  }
});

// Resolve a task with optional manager score override + comments + coaching flag
router.post("/qa/tasks/:id/resolve", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const resolvedBy = req.user!.username;
    const notes = String(req.body?.notes ?? "").trim() || null;
    const comments = String(req.body?.comments ?? "").trim() || null;
    const coachingComplete = Boolean(req.body?.coachingComplete);
    const managerScoreRaw = req.body?.managerScore;
    const managerScore =
      managerScoreRaw === undefined || managerScoreRaw === null || managerScoreRaw === ""
        ? null
        : Math.max(0, Math.min(100, Math.round(Number(managerScoreRaw))));

    // Fetch existing to compute variance + final
    const [existing] = await db
      .select()
      .from(managerQaTasksTable)
      .where(eq(managerQaTasksTable.id, id ?? ""))
      .limit(1);
    if (!existing) return res.status(404).json({ error: "not found" });

    const variance = managerScore !== null ? managerScore - existing.aiScore : null;
    const finalScore = managerScore !== null ? managerScore : existing.aiScore;

    const [updated] = await db
      .update(managerQaTasksTable)
      .set({
        status: "resolved",
        resolvedBy,
        resolvedAt: new Date(),
        notes,
        comments,
        managerScore,
        variance,
        finalScore,
        coachingComplete,
      })
      .where(eq(managerQaTasksTable.id, id ?? ""))
      .returning();
    return res.json(updated);
  } catch (err) {
    req.log.error(err, "qa resolve error");
    return res.status(500).json({ error: "Unable to resolve QA task." });
  }
});

// Per-agent leaderboard (for Agent Dashboard view)
router.get("/qa/agents", requireAuth, async (req, res) => {
  try {
    const range = qaRequestDateRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const dateBasis = parseQaDateBasis(req.query["dateBasis"]);
    if (!dateBasis) return res.status(400).json({ error: "dateBasis must be evaluated or call" });
    const dateColumn = qaReviewDateColumn(dateBasis);

    const filters = [gte(dateColumn, from), lte(dateColumn, to)];
    if (depts) filters.push(inArray(qaReviewsTable.department, depts));

    const agentScope = await qaAgentScope(req.user!);
    const agentPredicate = agentScope.predicateFor(qaReviewsTable.agentName);
    if (agentPredicate) filters.push(agentPredicate);
    const queriedRows = await db
      .select({
        agentName: qaReviewsTable.agentName,
        department: qaReviewsTable.department,
        reviewed: sql<number>`cast(count(*) as int)`,
        avgScore: sql<number>`cast(round(avg(${qaReviewsTable.score})) as int)`,
        avgProtocol: sql<number>`cast(round(avg(${qaReviewsTable.protocolScore})) as int)`,
        avgSoftSkills: sql<number>`cast(round(avg(${qaReviewsTable.softSkillsScore})) as int)`,
        criticalFails: sql<number>`cast(sum(case when ${qaReviewsTable.criticalFail} then 1 else 0 end) as int)`,
        failed: sql<number>`cast(sum(case when ${qaReviewsTable.pass} = false then 1 else 0 end) as int)`,
      })
      .from(qaReviewsTable)
      .where(and(...filters))
      .groupBy(qaReviewsTable.agentName, qaReviewsTable.department)
      .orderBy(sql`avg(${qaReviewsTable.score}) asc`);
    const rows = queriedRows.filter((row) => agentScope.canAccess(row.agentName));

    return res.json({ agents: rows, dateBasis });
  } catch (err) {
    req.log.error(err, "qa agents error");
    return res.status(500).json({ error: "Unable to load QA agents." });
  }
});

export default router;
