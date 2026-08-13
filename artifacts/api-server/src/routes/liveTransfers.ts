import { Router, type IRouter } from "express";
import {
  buildLiveTransferWorkbook,
  getLiveTransferStatus,
  requestLiveTransferRefresh,
} from "../modules/transfers/liveTransfers.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  setPrivateDownloadHeaders,
  validateOptionalWorkflowRange,
} from "../lib/sensitiveWorkflowPolicy.js";

const router: IRouter = Router();

router.get("/live-transfers/status", requireAuth, async (req, res) => {
  try {
    const requestedRange = validateOptionalWorkflowRange(req.query["from"], req.query["to"]);
    if (!requestedRange.ok) return res.status(400).json({ error: requestedRange.error });
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    return res.json(await getLiveTransferStatus(from, to));
  } catch (error) {
    req.log.error(error, "live-transfers status error");
    return res.status(500).json({ error: "Unable to load live transfers." });
  }
});

router.post("/live-transfers/refresh", requireAuth, requireRole("admin"), async (req, res) => {
  const result = await requestLiveTransferRefresh(req.user!.userId);
  if (result.status === "already_running") {
    return res.status(409).json({ started: false, reason: "already running" });
  }
  if (result.status === "rate_limited") {
    res.setHeader("Retry-After", String(result.retryAfter));
    return res.status(429).json({ error: "Live-transfer refresh limit reached" });
  }
  if (result.status === "controls_unavailable") {
    return res.status(503).json({ error: "Live-transfer refresh controls are unavailable" });
  }
  if (result.status === "queue_unavailable") {
    req.log.error(result.error, "live-transfer refresh enqueue failed");
    return res.status(503).json({ error: "Live-transfer refresh could not be queued" });
  }
  return res.json({ started: true });
});

router.get("/live-transfers/download", requireAuth, async (req, res) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    const requestedRange = validateOptionalWorkflowRange(from, to);
    if (!requestedRange.ok) return res.status(400).json({ error: requestedRange.error });
    const workbook = await buildLiveTransferWorkbook(from, to);
    setPrivateDownloadHeaders(res, "Live_Transfers.xlsx");
    await workbook.xlsx.write(res);
    res.end();
    return;
  } catch (error) {
    req.log.error(error, "live-transfers download error");
    res.status(500).json({ error: "Unable to generate live transfers report." });
    return;
  }
});

export default router;
