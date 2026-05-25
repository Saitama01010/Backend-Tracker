import { Router, type IRouter } from "express";
import { db, phoneCallsTable, qaReviewsTable, managerQaTasksTable } from "@workspace/db";
import { and, desc, eq, gte, lte, sql, isNull, inArray } from "drizzle-orm";
import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import { canonicalAgentName } from "./quoSync.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router: IRouter = Router();

const QA_MODEL = process.env["QA_MODEL"] ?? "gpt-4.1-mini";
const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

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

interface QaResult {
  department?: string;
  categoryScores: Record<string, number>;
  score: number;
  softSkillsScore?: number;
  protocolScore?: number;
  pass: boolean;
  criticalFail: boolean;
  strengths: string[];
  missedItems: string[];
  criticalIssues?: string[];
  reason: string;
  managerReviewRequired: boolean;
}

// ── OpenPhone fetch helpers ─────────────────────────────────────────────────
async function fetchOpenPhoneJson(url: string): Promise<unknown | null> {
  const QUO_KEY = process.env["QUO_API_KEY"] ?? "";
  if (!QUO_KEY) return null;
  try {
    const r = await fetch(url, { headers: { Authorization: QUO_KEY } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function getTranscriptAndSummary(callId: string): Promise<{ transcript: string; summary: string } | null> {
  type SumResp = { data?: { summary?: string[]; nextSteps?: string[]; status?: string } };
  type TxResp  = { data?: { dialogue?: Array<{ identifier?: string; content?: string }>; status?: string } };
  const [sum, tx] = await Promise.all([
    fetchOpenPhoneJson(`https://api.openphone.com/v1/call-summaries/${callId}`) as Promise<SumResp | null>,
    fetchOpenPhoneJson(`https://api.openphone.com/v1/call-transcripts/${callId}`) as Promise<TxResp | null>,
  ]);
  const dialogue = (tx?.data?.dialogue ?? [])
    .map((d) => `${d.identifier ?? "?"}: ${d.content ?? ""}`)
    .join("\n");
  const summary = (sum?.data?.summary ?? []).join(" ");
  if (!dialogue) return null;
  return { transcript: dialogue, summary };
}

// ── Core evaluation ─────────────────────────────────────────────────────────
async function evaluateCall(callId: string, opts?: { source?: string }): Promise<typeof qaReviewsTable.$inferSelect | null> {
  const [call] = await db.select().from(phoneCallsTable).where(eq(phoneCallsTable.id, callId)).limit(1);
  if (!call) return null;
  if (call.status !== "completed") return null;
  if ((call.durationSeconds ?? 0) < 30) return null;

  // Department detection: start from line classification (already retention/cs/nsf/other)
  const initialDept = lineTeamToDepartment(call.lineTeam);
  if (!initialDept) return null; // skip "other" lines — not a tracked department

  const td = await getTranscriptAndSummary(callId);
  if (!td) return null;

  // Truncate very long transcripts
  const transcript = td.transcript.length > 16000 ? td.transcript.slice(0, 16000) + "\n[...truncated]" : td.transcript;

  const agentName = canonicalAgentName(call.agentName) ?? "Unknown";

  const completion = await openai.chat.completions.create({
    model: QA_MODEL,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: buildSystemPrompt(initialDept) },
      {
        role: "user",
        content: `Agent: ${agentName}\nCustomer line: ${call.lineName}\nLine-classified department: ${initialDept}\nDirection: ${call.direction}\nDuration: ${call.durationSeconds}s\nAI summary: ${td.summary || "(none)"}\n\nTRANSCRIPT:\n${transcript}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: QaResult;
  try {
    parsed = JSON.parse(raw) as QaResult;
  } catch {
    logger.warn({ callId, raw: raw.slice(0, 200) }, "qa: failed to parse model JSON");
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
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 6) : [],
    missedItems: Array.isArray(parsed.missedItems) ? parsed.missedItems.slice(0, 6) : [],
    criticalIssues: Array.isArray(parsed.criticalIssues) ? parsed.criticalIssues.slice(0, 6) : [],
    categoryScores,
    reason: parsed.reason ?? null,
    managerReviewRequired,
    model: QA_MODEL,
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
      source: opts?.source ?? "auto_flag",
      status: "open",
    }).onConflictDoNothing();
  }

  const [saved] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, callId)).limit(1);
  return saved ?? null;
}

// ── Background processor (all 3 departments) ────────────────────────────────
let processorRunning = false;
async function runProcessor(batchSize = 5): Promise<{ evaluated: number; skipped: number; errors: number }> {
  if (processorRunning) return { evaluated: 0, skipped: 0, errors: 0 };
  processorRunning = true;
  let evaluated = 0, skipped = 0, errors = 0;
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const candidates = await db
      .select({
        id: phoneCallsTable.id,
        lineTeam: phoneCallsTable.lineTeam,
      })
      .from(phoneCallsTable)
      .leftJoin(qaReviewsTable, eq(qaReviewsTable.id, phoneCallsTable.id))
      .where(and(
        gte(phoneCallsTable.createdAt, cutoff),
        eq(phoneCallsTable.status, "completed"),
        gte(phoneCallsTable.durationSeconds, 30),
        isNull(qaReviewsTable.id),
        inArray(phoneCallsTable.lineTeam, ["retention", "cs", "nsf"]),
      ))
      .orderBy(desc(phoneCallsTable.createdAt))
      .limit(batchSize);

    for (const c of candidates) {
      try {
        const r = await evaluateCall(c.id);
        if (r) evaluated++; else skipped++;
      } catch (err) {
        errors++;
        logger.error({ err, callId: c.id }, "qa: evaluate failed");
      }
    }
  } finally {
    processorRunning = false;
  }
  return { evaluated, skipped, errors };
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

export function startQaBackgroundProcessor() {
  const intervalMs = 60 * 1000; // every minute
  const tick = async () => {
    try {
      const r = await runProcessor(25); // 25 calls/minute → ~1500/hour
      if (r.evaluated > 0 || r.errors > 0) logger.info(r, "qa: processor tick");
    } catch (err) {
      logger.error({ err }, "qa: processor tick failed");
    }
  };
  setTimeout(tick, 10_000);
  setInterval(tick, intervalMs);

  // Weekly assignment: every 6h check if we should run (Monday in LA)
  const weeklyTick = async () => {
    try {
      const nowLA = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      if (nowLA.getDay() !== 1) return; // Monday only
      const r = await runWeeklyAssignment();
      if (r.created > 0) logger.info(r, "qa: weekly assignment");
    } catch (err) {
      logger.error({ err }, "qa: weekly assignment failed");
    }
  };
  setTimeout(weeklyTick, 60_000);
  setInterval(weeklyTick, 6 * 60 * 60 * 1000);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function deptFilterArr(req: { query: Record<string, unknown> }): Department[] | null {
  const d = String(req.query["department"] ?? "").trim().toLowerCase();
  if (!d || d === "all") return null;
  const map: Record<string, Department> = { retention: "Retention", cs: "CS", nsf: "NSF" };
  return map[d] ? [map[d]] : null;
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.post("/qa/evaluate", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const callId = String(req.body?.callId ?? "").trim();
    if (!callId) return res.status(400).json({ error: "callId required" });
    const r = await evaluateCall(callId, { source: "manual" });
    if (!r) return res.status(404).json({ error: "Call not eligible or transcript unavailable" });
    return res.json(r);
  } catch (err) {
    req.log.error(err, "qa evaluate error");
    return res.status(500).json({ error: String(err) });
  }
});

router.post("/qa/process", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const batch = Math.min(parseInt(String(req.body?.batchSize ?? "25"), 10) || 25, 100);
    const r = await runProcessor(batch);
    return res.json(r);
  } catch (err) {
    req.log.error(err, "qa process error");
    return res.status(500).json({ error: String(err) });
  }
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
    const byDept: Record<string, { reviewed: number; avgScore: number; criticalFails: number; failed: number }> = {};
    for (const r of rows) {
      const d = r.department || "Unknown";
      if (!byDept[d]) byDept[d] = { reviewed: 0, avgScore: 0, criticalFails: 0, failed: 0 };
      byDept[d].reviewed++;
      byDept[d].avgScore += r.score;
      if (r.criticalFail) byDept[d].criticalFails++;
      if (!r.pass) byDept[d].failed++;
    }
    for (const d of Object.keys(byDept)) {
      const b = byDept[d];
      b.avgScore = b.reviewed ? Math.round(b.avgScore / b.reviewed) : 0;
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
      byDept,
    });
  } catch (err) {
    req.log.error(err, "qa stats error");
    return res.status(500).json({ error: String(err) });
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
    const [row] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, req.params.id)).limit(1);
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
      .where(eq(managerQaTasksTable.id, req.params.id))
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
      .where(eq(managerQaTasksTable.id, req.params.id))
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
