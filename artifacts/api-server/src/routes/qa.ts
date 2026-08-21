import { Router, type IRouter, type Response } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { setPrivateDownloadHeaders } from "../lib/sensitiveWorkflowPolicy.js";
import type { AuthPayload } from "../middleware/authCore.js";
import { validCronAuthorization } from "../lib/cronAuth.js";
import {
  parseQaDateBasisQuery,
  parseQaDepartment,
  parseQaEvaluationRequest,
  parseQaListLimit,
  parseQaRequestDateRange,
  parseQaTaskResolution,
  type QaDepartment as Department,
} from "../modules/qa/qa.schemas.js";
import {
  enqueueScheduledBiweeklyQa,
  getLatestQaRun,
  runAdminBiweeklyQa,
  runWeeklyAssignment,
} from "../modules/qa/qa.jobs.service.js";
import {
  authorizeQaDepartments,
  resolveQaAgentScope,
  type QaAgentScope,
} from "../modules/qa/qa.authorization.js";
import {
  QaReportingError,
  qaReportingService,
} from "../modules/qa/qa.reporting.service.js";
import { qaExportService } from "../modules/qa/qa.export.service.js";
import { qaManualEvaluationService } from "../modules/qa/qa.manual.service.js";

const router: IRouter = Router();

export type { QaDepartment as Department } from "../modules/qa/qa.schemas.js";
// ── Helpers ─────────────────────────────────────────────────────────────────
type QaDepartmentRouteScope =
  | { ok: true; departments: Department[] | null }
  | { ok: false; status: 400 | 403; error: string };

function deptFilterArr(req: { query: Record<string, unknown>; user?: AuthPayload }): QaDepartmentRouteScope {
  const parsed = parseQaDepartment(req.query["department"]);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  return authorizeQaDepartments(req.user!, parsed.requested);
}

async function qaAgentScope(user: AuthPayload): Promise<QaAgentScope> {
  return resolveQaAgentScope(user);
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.post("/qa/evaluate", requireAuth, requireRole("admin"), async (req, res) => {
  const parsed = parseQaEvaluationRequest(req.body, req.get("idempotency-key"));
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const outcome = await qaManualEvaluationService.evaluate({
    ...parsed.value,
    userId: req.user!.userId,
  });
  if (outcome.retryAfter !== undefined) {
    res.setHeader("Retry-After", String(outcome.retryAfter));
  }
  return res.status(outcome.status).json(outcome.body);
});

async function runBiweeklyResponse(res: Response, userId: number) {
  const outcome = await runAdminBiweeklyQa(userId);
  if (outcome.kind === "completed") return res.json(outcome.result);
  if (outcome.kind === "rate_limited") {
    res.setHeader("Retry-After", String(outcome.retryAfter));
    return res.status(429).json({ error: "QA run limit reached" });
  }
  if (outcome.kind === "active") {
    res.setHeader("Retry-After", String(outcome.retryAfter));
    return res.status(409).json({
      error: "A biweekly QA run is already active",
      activeRun: outcome.activeRun ?? null,
    });
  }
  return res.status(500).json({ error: "Biweekly QA run failed" });
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
  const run = await getLatestQaRun();
  return res.json({ run: run ?? null });
});

router.get("/qa/biweekly-run", async (req, res) => {
  const secret = process.env["CRON_SECRET"]?.trim();
  if (!secret || secret.length < 16) return res.status(503).json({ error: "CRON_SECRET is not configured" });
  if (!validCronAuthorization(req.get("authorization"), secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    return res.json(await enqueueScheduledBiweeklyQa());
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
    const range = parseQaRequestDateRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const parsedDateBasis = parseQaDateBasisQuery(req.query["dateBasis"]);
    if (!parsedDateBasis.ok) return res.status(400).json({ error: parsedDateBasis.error });
    const { dateBasis } = parsedDateBasis;
    const agentScope = await qaAgentScope(req.user!);
    return res.json(await qaReportingService.getStats({
      from,
      to,
      dateBasis,
      departments: depts,
      agentScope,
    }));
  } catch (err) {
    req.log.error(err, "qa stats error");
    return res.status(500).json({ error: "Unable to load QA statistics." });
  }
});

// GET /api/qa/download — Excel export of QA reviews (with a Mentions Tax flag).
router.get("/qa/download", requireAuth, async (req, res) => {
  try {
    const range = parseQaRequestDateRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const parsedDateBasis = parseQaDateBasisQuery(req.query["dateBasis"]);
    if (!parsedDateBasis.ok) return res.status(400).json({ error: parsedDateBasis.error });
    const { dateBasis } = parsedDateBasis;
    const agentScope = await qaAgentScope(req.user!);
    const workbook = await qaExportService.buildWorkbook({
      from,
      to,
      dateBasis,
      departments: depts,
      agentScope,
    });
    setPrivateDownloadHeaders(res, "QA_Reviews.xlsx");
    await workbook.xlsx.write(res);
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
    const range = parseQaRequestDateRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const agent = (req.query["agent"] as string) || "";
    const limit = parseQaListLimit(req.query["limit"]);
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const parsedDateBasis = parseQaDateBasisQuery(req.query["dateBasis"]);
    if (!parsedDateBasis.ok) return res.status(400).json({ error: parsedDateBasis.error });
    const { dateBasis } = parsedDateBasis;
    const agentScope = await qaAgentScope(req.user!);
    return res.json(await qaReportingService.listReviews({
      from,
      to,
      dateBasis,
      departments: depts,
      agentScope,
      agent,
      limit,
    }));
  } catch (err) {
    if (err instanceof QaReportingError) return res.status(err.status).json(err.response);
    req.log.error(err, "qa reviews error");
    return res.status(500).json({ error: "Unable to load QA reviews." });
  }
});

router.get("/qa/reviews/:id", requireAuth, async (req, res) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    return res.json(await qaReportingService.getReview({
      id: id ?? "",
      actor: req.user!,
      department: req.query["department"],
    }));
  } catch (err) {
    if (err instanceof QaReportingError) return res.status(err.status).json(err.response);
    req.log.error(err, "qa review fetch error");
    return res.status(500).json({ error: "Unable to load QA review." });
  }
});

router.get("/qa/tasks", requireAuth, async (req, res) => {
  try {
    const status = (req.query["status"] as string) || "open";
    const limit = parseQaListLimit(req.query["limit"]);
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const statuses = status === "all" ? ["open", "resolved"] : [status];
    const agentScope = await qaAgentScope(req.user!);
    return res.json(await qaReportingService.listTasks({
      statuses,
      departments: depts,
      agentScope,
      limit,
    }));
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
    const resolution = parseQaTaskResolution(req.body);
    return res.json(await qaReportingService.resolveTask({
      id: id ?? "",
      resolvedBy,
      resolution,
    }));
  } catch (err) {
    if (err instanceof QaReportingError) return res.status(err.status).json(err.response);
    req.log.error(err, "qa resolve error");
    return res.status(500).json({ error: "Unable to resolve QA task." });
  }
});

// Per-agent leaderboard (for Agent Dashboard view)
router.get("/qa/agents", requireAuth, async (req, res) => {
  try {
    const range = parseQaRequestDateRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const departmentScope = deptFilterArr(req);
    if (!departmentScope.ok) return res.status(departmentScope.status).json({ error: departmentScope.error });
    const depts = departmentScope.departments;
    const parsedDateBasis = parseQaDateBasisQuery(req.query["dateBasis"]);
    if (!parsedDateBasis.ok) return res.status(400).json({ error: parsedDateBasis.error });
    const { dateBasis } = parsedDateBasis;
    const agentScope = await qaAgentScope(req.user!);
    return res.json(await qaReportingService.listAgents({
      from,
      to,
      dateBasis,
      departments: depts,
      agentScope,
    }));
  } catch (err) {
    req.log.error(err, "qa agents error");
    return res.status(500).json({ error: "Unable to load QA agents." });
  }
});

export default router;
