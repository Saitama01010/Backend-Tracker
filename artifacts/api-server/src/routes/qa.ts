import { Router, type IRouter } from "express";
import { db, phoneCallsTable, qaReviewsTable, managerQaTasksTable } from "@workspace/db";
import { and, desc, eq, gte, lte, sql, isNull, inArray } from "drizzle-orm";
import OpenAI from "openai";
import { logger } from "../lib/logger.js";
import { canonicalAgentName } from "./quoSync.js";

const router: IRouter = Router();

const QA_MODEL = process.env["QA_MODEL"] ?? "gpt-4.1-mini";
const openai = new OpenAI({
  baseURL: process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"],
  apiKey: process.env["AI_INTEGRATIONS_OPENAI_API_KEY"],
});

// ── Retention team detection ────────────────────────────────────────────────
const RETENTION_LINE_RE = /retention|jacob|levi|ryan|rick|adam|mike|austin|maison|john\s*marcus|max\s*francis|michael\s*belfort|henry|katherine|chase|talia|dean|nora|carla|youssef\s*nady/i;
function isRetentionCall(row: { lineTeam: string; lineName: string }) {
  if (row.lineTeam === "retention") return true;
  return RETENTION_LINE_RE.test(row.lineName);
}

// ── Scorecard ───────────────────────────────────────────────────────────────
const SCORECARD = {
  greeting: 10,
  empathy: 10,
  askedReason: 10,
  attemptedRetention: 20,
  usedFramework: 20,
  handledObjection: 10,
  presentedSolution: 10,
  properClose: 10,
};

const QA_SYSTEM_PROMPT = `You are a strict but fair Retention QA evaluator for an outbound retention call center.

You will be given a phone-call transcript between a Retention Agent and a Customer who is calling to cancel (or being called about their cancellation). Score the AGENT against the Retention QA scorecard.

SCORECARD (max 100 total):
- greeting (10): proper professional greeting, agent identifies themselves and the company
- empathy (10): agent acknowledges the customer's frustration / situation
- askedReason (10): agent asks WHY the customer wants to cancel
- attemptedRetention (20): agent makes a clear, deliberate save attempt — not just "ok"
- usedFramework (20): agent follows a retention framework — feel/felt/found, value-stack, reframe, etc.
- handledObjection (10): agent addresses each objection rather than ignoring it
- presentedSolution (10): agent offers a concession, discount, plan change, or concrete solution
- properClose (10): proper recap and close (next steps, thank-you, summary)

CRITICAL FAIL CONDITIONS (set criticalFail=true and pass=false regardless of score):
- No retention attempt at all
- Customer explicitly requested cancellation and agent made no save attempt
- Agent was rude, dismissive, or hostile
- Call ended without addressing the cancellation reason

OUTPUT — return JSON ONLY (no markdown, no commentary), matching this exact shape:
{
  "categoryScores": { "greeting": 0-10, "empathy": 0-10, "askedReason": 0-10, "attemptedRetention": 0-20, "usedFramework": 0-20, "handledObjection": 0-10, "presentedSolution": 0-10, "properClose": 0-10 },
  "score": 0-100,
  "pass": true|false,
  "criticalFail": true|false,
  "strengths": ["short bullet", "short bullet"],
  "missedItems": ["short bullet", "short bullet"],
  "reason": "1-2 sentence overall assessment",
  "managerReviewRequired": true|false
}

Rules:
- score MUST equal the sum of the categoryScores.
- pass = score >= 80 AND criticalFail == false.
- managerReviewRequired = (score < 80) OR criticalFail.
- Be concise in strengths/missedItems (max 4 bullets each, ~10 words each).`;

interface QaResult {
  categoryScores: Record<string, number>;
  score: number;
  pass: boolean;
  criticalFail: boolean;
  strengths: string[];
  missedItems: string[];
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
async function evaluateCall(callId: string): Promise<QaReview | null> {
  // Get call row
  const [call] = await db.select().from(phoneCallsTable).where(eq(phoneCallsTable.id, callId)).limit(1);
  if (!call) return null;
  if (!isRetentionCall(call)) return null;
  if (call.status !== "completed") return null;
  if ((call.durationSeconds ?? 0) < 30) return null;

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
      { role: "system", content: QA_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Agent: ${agentName}\nCustomer line: ${call.lineName}\nDirection: ${call.direction}\nDuration: ${call.durationSeconds}s\nAI summary: ${td.summary || "(none)"}\n\nTRANSCRIPT:\n${transcript}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: QaResult;
  try {
    parsed = JSON.parse(raw) as QaResult;
  } catch (e) {
    logger.warn({ callId, raw: raw.slice(0, 200) }, "qa: failed to parse model JSON");
    return null;
  }

  // Sanity defaults
  const categoryScores = parsed.categoryScores ?? {};
  const computedScore = Object.values(categoryScores).reduce((a, b) => a + (Number(b) || 0), 0);
  const score = Math.max(0, Math.min(100, Math.round(parsed.score ?? computedScore)));
  const criticalFail = Boolean(parsed.criticalFail);
  const pass = !criticalFail && score >= 80;
  const managerReviewRequired = criticalFail || score < 80;

  const reviewRow = {
    id: callId,
    agentName,
    phoneNumber: call.participant,
    callDate: call.createdAt,
    lineTeam: call.lineTeam,
    transcript: transcript.slice(0, 8000),
    aiSummary: td.summary || null,
    score,
    pass,
    criticalFail,
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 6) : [],
    missedItems: Array.isArray(parsed.missedItems) ? parsed.missedItems.slice(0, 6) : [],
    categoryScores,
    reason: parsed.reason ?? null,
    managerReviewRequired,
    model: QA_MODEL,
  } satisfies typeof qaReviewsTable.$inferInsert;

  await db.insert(qaReviewsTable).values(reviewRow).onConflictDoUpdate({
    target: qaReviewsTable.id,
    set: {
      score: reviewRow.score,
      pass: reviewRow.pass,
      criticalFail: reviewRow.criticalFail,
      strengths: reviewRow.strengths,
      missedItems: reviewRow.missedItems,
      categoryScores: reviewRow.categoryScores,
      reason: reviewRow.reason,
      managerReviewRequired: reviewRow.managerReviewRequired,
      evaluatedAt: new Date(),
    },
  });

  if (managerReviewRequired) {
    await db.insert(managerQaTasksTable).values({
      id: callId,
      agentName,
      score,
      reason: parsed.reason ?? (criticalFail ? "Critical fail" : "Score below 80"),
      criticalFail,
      status: "open",
    }).onConflictDoNothing();
  }

  const [saved] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, callId)).limit(1);
  return saved ?? null;
}

// ── Background processor ────────────────────────────────────────────────────
let processorRunning = false;
async function runProcessor(batchSize = 5): Promise<{ evaluated: number; skipped: number; errors: number }> {
  if (processorRunning) return { evaluated: 0, skipped: 0, errors: 0 };
  processorRunning = true;
  let evaluated = 0, skipped = 0, errors = 0;
  try {
    // Find recent completed retention calls with no QA review yet, last 7 days
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const candidates = await db
      .select({
        id: phoneCallsTable.id,
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        durationSeconds: phoneCallsTable.durationSeconds,
        status: phoneCallsTable.status,
      })
      .from(phoneCallsTable)
      .leftJoin(qaReviewsTable, eq(qaReviewsTable.id, phoneCallsTable.id))
      .where(and(
        gte(phoneCallsTable.createdAt, cutoff),
        eq(phoneCallsTable.status, "completed"),
        gte(phoneCallsTable.durationSeconds, 30),
        isNull(qaReviewsTable.id),
      ))
      .orderBy(desc(phoneCallsTable.createdAt))
      .limit(batchSize * 3);

    const retentionOnly = candidates.filter((c) => isRetentionCall(c)).slice(0, batchSize);

    for (const c of retentionOnly) {
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

export function startQaBackgroundProcessor() {
  const intervalMs = 5 * 60 * 1000; // every 5 minutes
  const tick = async () => {
    try {
      const r = await runProcessor(5);
      if (r.evaluated > 0 || r.errors > 0) {
        logger.info(r, "qa: processor tick");
      }
    } catch (err) {
      logger.error({ err }, "qa: processor tick failed");
    }
  };
  setTimeout(tick, 30_000); // first run shortly after boot
  setInterval(tick, intervalMs);
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Manual single-call evaluation
router.post("/qa/evaluate", async (req, res) => {
  try {
    const callId = String(req.body?.callId ?? "").trim();
    if (!callId) return res.status(400).json({ error: "callId required" });
    const r = await evaluateCall(callId);
    if (!r) return res.status(404).json({ error: "Call not eligible or transcript unavailable" });
    return res.json(r);
  } catch (err) {
    req.log.error(err, "qa evaluate error");
    return res.status(500).json({ error: String(err) });
  }
});

// Trigger background processor on demand
router.post("/qa/process", async (req, res) => {
  try {
    const batch = Math.min(parseInt(String(req.body?.batchSize ?? "5"), 10) || 5, 20);
    const r = await runProcessor(batch);
    return res.json(r);
  } catch (err) {
    req.log.error(err, "qa process error");
    return res.status(500).json({ error: String(err) });
  }
});

// Aggregate stats
router.get("/qa/stats", async (req, res) => {
  try {
    const from = req.query["from"] ? new Date(String(req.query["from"])) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = req.query["to"] ? new Date(String(req.query["to"])) : new Date();
    const rows = await db
      .select({
        id: qaReviewsTable.id, score: qaReviewsTable.score, pass: qaReviewsTable.pass,
        criticalFail: qaReviewsTable.criticalFail, managerReviewRequired: qaReviewsTable.managerReviewRequired,
      })
      .from(qaReviewsTable)
      .where(and(gte(qaReviewsTable.callDate, from), lte(qaReviewsTable.callDate, to)));

    const reviewed = rows.length;
    const avgScore = reviewed ? Math.round(rows.reduce((a, r) => a + r.score, 0) / reviewed) : 0;
    const failed = rows.filter((r) => !r.pass).length;
    const criticalFails = rows.filter((r) => r.criticalFail).length;

    const [{ pending }] = await db
      .select({ pending: sql<number>`cast(count(*) as int)` })
      .from(managerQaTasksTable)
      .where(eq(managerQaTasksTable.status, "open"));

    return res.json({ reviewed, avgScore, failed, criticalFails, pendingReviews: Number(pending) || 0 });
  } catch (err) {
    req.log.error(err, "qa stats error");
    return res.status(500).json({ error: String(err) });
  }
});

// Review list
router.get("/qa/reviews", async (req, res) => {
  try {
    const from = req.query["from"] ? new Date(String(req.query["from"])) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = req.query["to"] ? new Date(String(req.query["to"])) : new Date();
    const agent = (req.query["agent"] as string) || "";
    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "100", 10) || 100, 500);
    const filters = [gte(qaReviewsTable.callDate, from), lte(qaReviewsTable.callDate, to)];
    if (agent) filters.push(sql`lower(${qaReviewsTable.agentName}) = ${agent.toLowerCase()}`);

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

// Single review (with full transcript)
router.get("/qa/reviews/:id", async (req, res) => {
  try {
    const [row] = await db.select().from(qaReviewsTable).where(eq(qaReviewsTable.id, req.params.id)).limit(1);
    if (!row) return res.status(404).json({ error: "not found" });
    return res.json(row);
  } catch (err) {
    req.log.error(err, "qa review fetch error");
    return res.status(500).json({ error: String(err) });
  }
});

// Manager tasks
router.get("/qa/tasks", async (req, res) => {
  try {
    const status = (req.query["status"] as string) || "open";
    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "100", 10) || 100, 500);
    const statuses = status === "all" ? ["open", "resolved"] : [status];
    const rows = await db
      .select()
      .from(managerQaTasksTable)
      .where(inArray(managerQaTasksTable.status, statuses))
      .orderBy(desc(managerQaTasksTable.createdAt))
      .limit(limit);
    return res.json({ tasks: rows });
  } catch (err) {
    req.log.error(err, "qa tasks error");
    return res.status(500).json({ error: String(err) });
  }
});

// Resolve a task
router.post("/qa/tasks/:id/resolve", async (req, res) => {
  try {
    const resolvedBy = String(req.body?.resolvedBy ?? "").trim() || "manager";
    const notes = String(req.body?.notes ?? "").trim() || null;
    const [updated] = await db
      .update(managerQaTasksTable)
      .set({ status: "resolved", resolvedBy, resolvedAt: new Date(), notes })
      .where(eq(managerQaTasksTable.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "not found" });
    return res.json(updated);
  } catch (err) {
    req.log.error(err, "qa resolve error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
