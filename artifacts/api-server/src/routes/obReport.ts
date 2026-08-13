import { Router, type IRouter } from "express";
import {
  buildOnboardingReportWorkbook,
  getOnboardingReportStatus,
  importOnboardingClassifications,
  requestOnboardingReportRefresh,
  type OnboardingClassificationImportRow,
} from "../modules/onboarding/report.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  setPrivateDownloadHeaders,
  validateOptionalWorkflowRange,
} from "../lib/sensitiveWorkflowPolicy.js";

const router: IRouter = Router();

router.post("/ob-report/refresh", requireAuth, requireRole("admin"), async (req, res) => {
  const result = await requestOnboardingReportRefresh(req.user!.userId);
  if (result.status === "already_running") {
    return res.status(409).json({ error: "A refresh is already running" });
  }
  if (result.status === "rate_limited") {
    res.setHeader("Retry-After", String(result.retryAfter));
    return res.status(429).json({ error: "Onboarding report refresh limit reached" });
  }
  if (result.status === "controls_unavailable") {
    return res.status(503).json({ error: "Onboarding refresh controls are unavailable" });
  }
  if (result.status === "queue_unavailable") {
    req.log.error(result.error, "onboarding refresh enqueue failed");
    return res.status(503).json({ error: "Onboarding refresh could not be queued" });
  }
  return res.json({ started: true });
});

router.get("/ob-report/status", requireAuth, async (req, res) => {
  try {
    const requestedRange = validateOptionalWorkflowRange(req.query["from"], req.query["to"]);
    if (!requestedRange.ok) return res.status(400).json({ error: requestedRange.error });
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    return res.json(await getOnboardingReportStatus(from, to));
  } catch (error) {
    req.log.error(error, "ob-report status error");
    return res.status(500).json({ error: "Failed to load report status" });
  }
});

router.get("/ob-report/download", requireAuth, async (req, res) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    const requestedRange = validateOptionalWorkflowRange(from, to);
    if (!requestedRange.ok) return res.status(400).json({ error: requestedRange.error });
    const workbook = await buildOnboardingReportWorkbook(from, to);
    const stamp = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    setPrivateDownloadHeaders(res, `Onboarding_Line_Report_${stamp}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
    return;
  } catch (error) {
    req.log.error(error, "ob-report download error");
    res.status(500).json({ error: "Failed to generate report" });
    return;
  }
});

router.post("/ob-report/import", async (req, res) => {
  const secret = process.env["OB_IMPORT_SECRET"];
  if (!secret) {
    res.status(403).json({ error: "import disabled" });
    return;
  }
  if (req.header("x-import-secret") !== secret) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const rows: unknown = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "rows[] required" });
    return;
  }
  if (rows.length > 5000) {
    res.status(400).json({ error: "too many rows in one request (max 5000)" });
    return;
  }
  const values: OnboardingClassificationImportRow[] = [];
  for (const row of rows as OnboardingClassificationImportRow[]) {
    if (!row || typeof row.callId !== "string" || typeof row.callType !== "string") {
      res.status(400).json({ error: "each row needs callId and callType" });
      return;
    }
    values.push({
      callId: row.callId,
      callType: row.callType,
      customerName: row.customerName ?? null,
      closerAgent: row.closerAgent ?? null,
      mentionsTax: typeof row.mentionsTax === "boolean" ? row.mentionsTax : null,
      txStatus: row.txStatus ?? null,
      notes: row.notes ?? null,
    });
  }
  try {
    res.json(await importOnboardingClassifications(values));
    return;
  } catch (error) {
    req.log.error(error, "ob-report import error");
    res.status(500).json({ error: "import failed" });
    return;
  }
});

export default router;
