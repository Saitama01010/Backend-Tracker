import { Router, type IRouter, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import { db, phoneCallsTable, qaReviewsTable, managerQaTasksTable, teamAgentsTable, qaBiweeklyRunsTable } from "@workspace/db";
import { and, desc, eq, gte, lte, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { canonicalAgentName } from "./quoSync.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { anthropicErrorStatus, createAnthropicClient, usageFields } from "../lib/anthropic.js";
import { AiRateLimitError, withDatabaseLease, withDurableAiLimit } from "../lib/aiRateLimit.js";
import { getQuoCallArtifacts, isSafeQuoCallId, type QuoCallArtifacts } from "../lib/quoCall.js";
import { shouldReuseStoredReview, stableEligibleCalls, validateQaResult } from "../lib/qaPolicy.js";

const router: IRouter = Router();

const QA_MODEL = process.env["ANTHROPIC_QA_MODEL"]?.trim() || "claude-haiku-4-5";
const QA_REVIEW_INTERVAL_DAYS = Math.max(1, Number(process.env["QA_REVIEW_INTERVAL_DAYS"] ?? 14) || 14);
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

OUTPUT — return JSON ONLY (no markdown, no commentary):
{
  "department": "Retention"|"CS"|"NSF",
  "categoryScores": { ...numeric per-category scores summing to "score" ... },
  "score": 0-100,
  "softSkillsScore": 0-100,
  "protocolScore": 0-100,
  "pass": true|false,
  "criticalFail": true|false,
  "strengths": ["short bullet", ...],   // max 4, ~10 words each
  "missedItems": ["short bullet", ...], // max 4
  "criticalIssues": ["short bullet", ...], // empty if none
  "reason": "1-2 sentence overall assessment",
  "managerReviewRequired": true|false
}

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
  return `${UNIVERSAL_PREAMBLE}\n\n${DEPT_RUBRICS[dept]}`;
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
  preserveEvaluatedAt?: boolean;
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
    completion = await createAnthropicClient().messages.create({
      model: QA_MODEL,
      max_tokens: 700,
      system: [{
        type: "text",
        text: buildSystemPrompt(initialDept),
        cache_control: { type: "ephemeral" },
      }],
      messages: [{
        role: "user",
        content: `Agent: ${agentName}\nCustomer line: ${call.lineName}\nLine-classified department: ${initialDept}\nDirection: ${call.direction}\nDuration: ${call.durationSeconds}s\nAI summary: ${td.summary || "(none)"}\nNext steps: ${td.nextSteps || "(none)"}\n\nTRANSCRIPT:\n${transcript}`,
      }],
    }, { signal: AbortSignal.timeout(30_000) });
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

  const raw = completion.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    logger.warn({ feature: "qa", userId: opts?.userId ?? 0, model: QA_MODEL, success: false }, "qa result validation failed");
    return null;
  }
  const parsed = validateQaResult(decoded, initialDept);
  if (!parsed) {
    logger.warn({ feature: "qa", userId: opts?.userId ?? 0, model: QA_MODEL, success: false }, "qa result validation failed");
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
      ...(!opts?.preserveEvaluatedAt ? { evaluatedAt: new Date() } : {}),
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
  evaluated: Array<{ agent: string; callId: string }>;
  skipped: Array<{ agent: string; reason: string }>;
  errors: Array<{ agent: string; reason: string }>;
}

function agentKey(value: string | null | undefined): string {
  return (canonicalAgentName(value) ?? value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function runBiweeklyQa(trigger: "cron" | "admin"): Promise<QaBiweeklyResult> {
  return withDatabaseLease("qa_auto_biweekly", async () => {
    const [run] = await db.insert(qaBiweeklyRunsTable).values({ trigger }).returning({ id: qaBiweeklyRunsTable.id });
    const result: QaBiweeklyResult = { evaluated: [], skipped: [], errors: [] };
    try {
      const cutoff = new Date(Date.now() - QA_REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
      const [roster, recentAutomatic, candidates, reviewed] = await Promise.all([
        db.select().from(teamAgentsTable).where(and(
          eq(teamAgentsTable.active, true),
          inArray(teamAgentsTable.team, ["retention", "cs", "nsf"]),
        )),
        db.select({ agentName: qaReviewsTable.agentName }).from(qaReviewsTable).where(and(
          eq(qaReviewsTable.source, "auto_biweekly"),
          gte(qaReviewsTable.evaluatedAt, cutoff),
        )),
        db.select().from(phoneCallsTable).where(and(
          gte(phoneCallsTable.createdAt, cutoff),
          eq(phoneCallsTable.status, "completed"),
          gte(phoneCallsTable.durationSeconds, QA_MIN_CALL_SECONDS),
          inArray(phoneCallsTable.lineTeam, ["retention", "cs", "nsf"]),
        )),
        db.select({ id: qaReviewsTable.id }).from(qaReviewsTable).where(gte(qaReviewsTable.callDate, cutoff)),
      ]);

      const automaticallyReviewed = new Set(recentAutomatic.map((row) => agentKey(row.agentName)));
      const reviewedCalls = new Set(reviewed.map((row) => row.id));
      const sortedCandidates = stableEligibleCalls(candidates, reviewedCalls, QA_MIN_CALL_SECONDS);

      for (const rosterAgent of [...roster].sort((a, b) => a.name.localeCompare(b.name))) {
        const key = agentKey(rosterAgent.name);
        if (automaticallyReviewed.has(key)) {
          result.skipped.push({ agent: rosterAgent.name, reason: `automatic review already exists within ${QA_REVIEW_INTERVAL_DAYS} days` });
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

        try {
          const review = await evaluateCall(selected.id, {
            source: "auto_biweekly",
            userId: 0,
            artifacts,
          });
          if (review) {
            result.evaluated.push({ agent: rosterAgent.name, callId: selected.id });
            automaticallyReviewed.add(key);
          } else {
            result.skipped.push({ agent: rosterAgent.name, reason: "Claude result failed server-side validation" });
          }
        } catch (error) {
          result.errors.push({ agent: rosterAgent.name, reason: `evaluation failed (${anthropicErrorStatus(error) ?? "internal"})` });
        }
      }

      if (run) {
        await db.update(qaBiweeklyRunsTable).set({
          status: "completed",
          result: { evaluated: result.evaluated, skipped: result.skipped, errors: result.errors },
          finishedAt: new Date(),
        })
          .where(eq(qaBiweeklyRunsTable.id, run.id));
      }
      return result;
    } catch (error) {
      if (run) {
        await db.update(qaBiweeklyRunsTable).set({
          status: "failed",
          result: { evaluated: result.evaluated, skipped: result.skipped, errors: result.errors },
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
  const nowLA = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const dow = nowLA.getDay(); // 0=Sun..6=Sat
  const daysSinceMon = (dow + 6) % 7;
  const mondayLA = new Date(nowLA);
  mondayLA.setDate(mondayLA.getDate() - daysSinceMon);
  mondayLA.setHours(0, 0, 0, 0);
  // mondayLA is a Date whose components reflect LA wall-clock; convert back to UTC instant
  const offsetMin = new Date(mondayLA.toLocaleString("en-US", { timeZone: "UTC" })).getTime() - mondayLA.getTime();
  return new Date(mondayLA.getTime() - offsetMin);
}

async function runWeeklyAssignment(): Promise<{ created: number; agents: number }> {
  const weekStart = currentLAWeekStart();
  const lookback = new Date(weekStart.getTime() - 7 * 24 * 3600 * 1000);

  // Eligible reviews: from the prior week through now (so Monday-morning runs see last week's calls).
  const reviews = await db
    .select()
    .from(qaReviewsTable)
    .where(gte(qaReviewsTable.callDate, lookback));

  const byAgent = new Map<string, typeof reviews>();
  for (const r of reviews) {
    if (!byAgent.has(r.agentName)) byAgent.set(r.agentName, [] as typeof reviews);
    byAgent.get(r.agentName)!.push(r);
  }

  let created = 0;
  for (const [agent, list] of byAgent) {
    if (list.length === 0) continue;

    // Skip agents that already have weekly tasks created on/after this week's Monday LA.
    const existingWeekly = await db
      .select({ id: managerQaTasksTable.id })
      .from(managerQaTasksTable)
      .where(and(
        eq(managerQaTasksTable.agentName, agent),
        inArray(managerQaTasksTable.source, ["weekly_lowest", "weekly_random"]),
        gte(managerQaTasksTable.createdAt, weekStart),
      ));
    if (existingWeekly.length > 0) continue;

    // Exclude calls that are already manager tasks (avoid PK conflicts collapsing picks).
    const existingIds = new Set<string>();
    const existingForAgent = await db
      .select({ id: managerQaTasksTable.id })
      .from(managerQaTasksTable)
      .where(eq(managerQaTasksTable.agentName, agent));
    for (const e of existingForAgent) existingIds.add(e.id);

    const eligible = list.filter((r) => !existingIds.has(r.id));
    if (eligible.length === 0) continue;

    const lowest = [...eligible].sort((a, b) => a.score - b.score)[0];
    const others = eligible.filter((r) => r.id !== lowest.id);
    const random = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : null;

    const picks: Array<{ row: (typeof reviews)[number]; source: string; reasonPrefix: string }> = [
      { row: lowest, source: "weekly_lowest", reasonPrefix: "Weekly review: lowest AI score" },
    ];
    if (random) picks.push({ row: random, source: "weekly_random", reasonPrefix: "Weekly review: random sample" });

    for (const p of picks) {
      const result = await db.insert(managerQaTasksTable).values({
        id: p.row.id,
        agentName: agent,
        department: p.row.department,
        aiScore: p.row.score,
        score: p.row.score,
        reason: `${p.reasonPrefix} (${p.row.score}/100)`,
        criticalFail: p.row.criticalFail,
        source: p.source,
        status: "open",
      }).onConflictDoNothing().returning({ id: managerQaTasksTable.id });
      if (result.length > 0) created++;
    }
  }

  return { created, agents: byAgent.size };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function deptFilterArr(req: { query: Record<string, unknown> }): Department[] | null {
  const d = String(req.query["department"] ?? "").trim().toLowerCase();
  if (!d || d === "all") return null;
  const map: Record<string, Department> = { retention: "Retention", cs: "CS", nsf: "NSF" };
  return map[d] ? [map[d]] : null;
}

// POSIX word-boundary regex matching "tax" or "taxes" (case-insensitive) inside a
// transcript — used both for QA stats counts and the per-review export flag.
const TAX_REGEX = String.raw`\ytax(es)?\y`;

// ── Routes ──────────────────────────────────────────────────────────────────

router.post("/qa/evaluate", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const callId = String(req.body?.callId ?? "").trim();
    const force = req.body?.force === true;
    if (!isSafeQuoCallId(callId)) return res.status(400).json({ error: "A valid QUO callId is required" });

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

    const existingWasAutomatic = existing?.source === "auto_biweekly";
    const review = await withDurableAiLimit({
      feature: "qa_manual",
      userId: req.user!.userId,
      perMinute: 3,
      perDay: 20,
    }, () => evaluateCall(callId, {
      source: existingWasAutomatic ? "auto_biweekly" : "manual_call_id",
      userId: req.user!.userId,
      artifacts,
      preserveEvaluatedAt: existingWasAutomatic,
    }));
    if (!review) return res.status(422).json({ error: "Call is not QA-eligible or Claude returned an invalid evaluation" });
    return res.json(review);
  } catch (err) {
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

async function runBiweeklyResponse(res: Response, trigger: "cron" | "admin") {
  try {
    return res.json(await runBiweeklyQa(trigger));
  } catch (err) {
    if (err instanceof AiRateLimitError) {
      res.setHeader("Retry-After", String(err.retryAfter));
      return res.status(429).json({ error: "A biweekly QA run is already active" });
    }
    return res.status(500).json({ error: "Biweekly QA run failed" });
  }
}

router.post("/qa/biweekly-run", requireAuth, requireRole("admin"), async (_req, res) => {
  return runBiweeklyResponse(res, "admin");
});

// Backward-compatible admin button endpoint; it now runs the same idempotent
// biweekly check and ignores the former batchSize option.
router.post("/qa/process", requireAuth, requireRole("admin"), async (_req, res) => {
  return runBiweeklyResponse(res, "admin");
});

router.get("/qa/biweekly-run", async (req, res) => {
  const secret = process.env["CRON_SECRET"]?.trim();
  if (!secret) return res.status(503).json({ error: "CRON_SECRET is not configured" });
  if (req.get("authorization") !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return runBiweeklyResponse(res, "cron");
});

router.post("/qa/assign-weekly", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await runWeeklyAssignment();
    return res.json(r);
  } catch (err) {
    req.log.error(err, "qa weekly assign error");
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/qa/stats", requireAuth, async (req, res) => {
  try {
    const from = req.query["from"] ? new Date(String(req.query["from"])) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = req.query["to"] ? new Date(String(req.query["to"])) : new Date();
    const depts = deptFilterArr(req);

    const filters = [gte(qaReviewsTable.callDate, from), lte(qaReviewsTable.callDate, to)];
    if (depts) filters.push(inArray(qaReviewsTable.department, depts));

    const rows = await db
      .select({
        id: qaReviewsTable.id,
        score: qaReviewsTable.score,
        softSkillsScore: qaReviewsTable.softSkillsScore,
        protocolScore: qaReviewsTable.protocolScore,
        pass: qaReviewsTable.pass,
        criticalFail: qaReviewsTable.criticalFail,
        managerReviewRequired: qaReviewsTable.managerReviewRequired,
        department: qaReviewsTable.department,
      })
      .from(qaReviewsTable)
      .where(and(...filters));

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
    }
    for (const d of Object.keys(byDept)) {
      const b = byDept[d];
      b.avgScore = b.reviewed ? Math.round(b.avgScore / b.reviewed) : 0;
    }

    // Tax mentions — count reviewed calls whose transcript mentions "tax"/"taxes",
    // grouped by department (same date/dept filters as the rest of the stats).
    const taxRows = await db
      .select({
        department: qaReviewsTable.department,
        cnt: sql<number>`cast(count(*) filter (where ${qaReviewsTable.transcript} ~* ${TAX_REGEX}) as int)`,
      })
      .from(qaReviewsTable)
      .where(and(...filters))
      .groupBy(qaReviewsTable.department);
    let taxMentions = 0;
    for (const t of taxRows) {
      const d = t.department || "Unknown";
      const n = Number(t.cnt) || 0;
      taxMentions += n;
      if (!byDept[d]) byDept[d] = { reviewed: 0, avgScore: 0, criticalFails: 0, failed: 0, taxMentions: 0 };
      byDept[d].taxMentions = n;
    }

    const taskFilters = [eq(managerQaTasksTable.status, "open")];
    if (depts) taskFilters.push(inArray(managerQaTasksTable.department, depts));
    const [{ pending }] = await db
      .select({ pending: sql<number>`cast(count(*) as int)` })
      .from(managerQaTasksTable)
      .where(and(...taskFilters));

    // Variance — only over resolved tasks with managerScore set
    const varianceFilters = [
      eq(managerQaTasksTable.status, "resolved"),
      sql`${managerQaTasksTable.managerScore} IS NOT NULL`,
      gte(managerQaTasksTable.createdAt, from),
      lte(managerQaTasksTable.createdAt, to),
    ];
    if (depts) varianceFilters.push(inArray(managerQaTasksTable.department, depts));
    const variRows = await db
      .select({ v: managerQaTasksTable.variance })
      .from(managerQaTasksTable)
      .where(and(...varianceFilters));
    const avgVariance = variRows.length
      ? Math.round((variRows.reduce((a, r) => a + Math.abs(r.v ?? 0), 0) / variRows.length) * 10) / 10
      : 0;

    return res.json({
      reviewed, avgScore, avgProtocol, avgSoftSkills,
      failed, criticalFails,
      pendingReviews: Number(pending) || 0,
      avgVariance,
      taxMentions,
      byDept,
    });
  } catch (err) {
    req.log.error(err, "qa stats error");
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/qa/download — Excel export of QA reviews (with a Mentions Tax flag).
router.get("/qa/download", requireAuth, async (req, res) => {
  try {
    const from = req.query["from"] ? new Date(String(req.query["from"])) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = req.query["to"] ? new Date(String(req.query["to"])) : new Date();
    const depts = deptFilterArr(req);

    const filters = [gte(qaReviewsTable.callDate, from), lte(qaReviewsTable.callDate, to)];
    if (depts) filters.push(inArray(qaReviewsTable.department, depts));

    const rows = await db
      .select({
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
      .orderBy(desc(qaReviewsTable.callDate));

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
      "Date (Los Angeles)", "Agent", "Department", "Customer Phone",
      "Score", "Protocol", "Soft Skills", "Result", "Critical Fail", "Mentions Tax", "AI Summary",
    ];
    const widths = [22, 22, 14, 16, 8, 10, 11, 10, 12, 13, 60];
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
      xr.getCell(1).value = new Date(row.callDate).toLocaleString("en-US", { timeZone: TZ });
      xr.getCell(2).value = row.agentName ?? "";
      xr.getCell(3).value = row.department ?? "";
      xr.getCell(4).value = row.phoneNumber ?? "";
      xr.getCell(5).value = row.score ?? 0;
      xr.getCell(6).value = row.protocolScore ?? 0;
      xr.getCell(7).value = row.softSkillsScore ?? 0;
      xr.getCell(8).value = row.pass ? "Pass" : "Fail";
      xr.getCell(9).value = row.criticalFail ? "YES" : "";
      const taxCell = xr.getCell(10);
      taxCell.value = row.mentionsTax ? "YES" : "";
      taxCell.alignment = { horizontal: "center" };
      if (row.mentionsTax) {
        taxCell.fill = solid("FFFEF3C7");
        taxCell.font = { bold: true, color: { argb: "FF92400E" } };
      }
      xr.getCell(11).value = row.aiSummary ?? "";
      xr.commit();
      r++;
    }
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, r - 1), column: ncols } };

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="QA_Reviews.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
    return;
  } catch (err) {
    req.log.error(err, "qa download error");
    res.status(500).json({ error: String(err) });
    return;
  }
});

router.get("/qa/reviews", requireAuth, async (req, res) => {
  try {
    const from = req.query["from"] ? new Date(String(req.query["from"])) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = req.query["to"] ? new Date(String(req.query["to"])) : new Date();
    const agent = (req.query["agent"] as string) || "";
    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "100", 10) || 100, 500);
    const depts = deptFilterArr(req);

    const filters = [gte(qaReviewsTable.callDate, from), lte(qaReviewsTable.callDate, to)];
    if (agent) filters.push(sql`lower(${qaReviewsTable.agentName}) = ${agent.toLowerCase()}`);
    if (depts) filters.push(inArray(qaReviewsTable.department, depts));

    const rows = await db
      .select()
      .from(qaReviewsTable)
      .where(and(...filters))
      .orderBy(desc(qaReviewsTable.callDate))
      .limit(limit);

    return res.json({ reviews: rows });
  } catch (err) {
    req.log.error(err, "qa reviews error");
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/qa/reviews/:id", requireAuth, async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [row] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, id ?? "")).limit(1);
    if (!row) return res.status(404).json({ error: "not found" });
    return res.json(row);
  } catch (err) {
    req.log.error(err, "qa review fetch error");
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/qa/tasks", requireAuth, async (req, res) => {
  try {
    const status = (req.query["status"] as string) || "open";
    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "100", 10) || 100, 500);
    const depts = deptFilterArr(req);
    const statuses = status === "all" ? ["open", "resolved"] : [status];
    const filters: any[] = [inArray(managerQaTasksTable.status, statuses)];
    if (depts) filters.push(inArray(managerQaTasksTable.department, depts));

    const rows = await db
      .select()
      .from(managerQaTasksTable)
      .where(and(...filters))
      .orderBy(desc(managerQaTasksTable.createdAt))
      .limit(limit);
    return res.json({ tasks: rows });
  } catch (err) {
    req.log.error(err, "qa tasks error");
    return res.status(500).json({ error: String(err) });
  }
});

// Resolve a task with optional manager score override + comments + coaching flag
router.post("/qa/tasks/:id/resolve", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const resolvedBy = String(req.body?.resolvedBy ?? "").trim() || "manager";
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
    return res.status(500).json({ error: String(err) });
  }
});

// Per-agent leaderboard (for Agent Dashboard view)
router.get("/qa/agents", requireAuth, async (req, res) => {
  try {
    const from = req.query["from"] ? new Date(String(req.query["from"])) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = req.query["to"] ? new Date(String(req.query["to"])) : new Date();
    const depts = deptFilterArr(req);

    const filters = [gte(qaReviewsTable.callDate, from), lte(qaReviewsTable.callDate, to)];
    if (depts) filters.push(inArray(qaReviewsTable.department, depts));

    const rows = await db
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

    return res.json({ agents: rows });
  } catch (err) {
    req.log.error(err, "qa agents error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
