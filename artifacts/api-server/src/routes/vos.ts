import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import type {
  RetentionPbxCallHistoryStat,
  RetentionPbxRingGroupMissed,
} from "../modules/retention/retention.pbx.types.js";
import {
  parsePbxBreakdownQuery,
  parsePbxCallbackReviewQuery,
  parsePbxDailyQuery,
  parsePbxHourlyQuery,
} from "../modules/pbx/pbx.schemas.js";
import { pbxDashboardService } from "../modules/pbx/pbx.dashboard.service.js";
import {
  PbxDiagnosticPathError,
  pbxDiagnosticsService,
} from "../modules/pbx/pbx.diagnostics.service.js";
import { pbxNoCallbackService } from "../modules/pbx/pbx.no-callback.service.js";
import { pbxRefreshService } from "../modules/pbx/pbx.refresh.service.js";

const router = Router();
router.use("/vos", requireAuth);

export type VosCallHistoryStat = RetentionPbxCallHistoryStat;
export type VosRingGroupMissed = RetentionPbxRingGroupMissed;
export {
  getCallHistoryCache,
  vosCallSpansCache,
  vosCallTimestampsCache,
} from "../modules/pbx/pbx.state.js";
export { hydratePbxState as hydrateVosState } from "../modules/pbx/pbx.state.js";
export { refreshPbxCallHistory as refreshCallHistory } from "../modules/pbx/pbx.refresh.service.js";

router.post("/vos/refresh", requireRole("admin"), async (req, res) => {
  try {
    await pbxRefreshService.enqueueManual(req.user!.userId);
    res.json({ ok: true });
  } catch (error) {
    req.log.error(error, "PBX refresh enqueue failed");
    res.status(503).json({ error: "PBX refresh could not be queued" });
  }
});

router.get("/vos/stats", async (req, res) => {
  try {
    res.json(await pbxDashboardService.getStats(req.user!, req.log));
  } catch (error) {
    req.log.error(error, "vos stats error");
    res.status(500).json({ error: "PBX statistics are temporarily unavailable." });
  }
});

router.get("/vos/missed-no-callback", async (req, res) => {
  return res.json(await pbxNoCallbackService.get({ actor: req.user!, log: req.log }));
});

router.get("/vos/missed-hourly", async (req, res) => {
  try {
    const parsed = parsePbxHourlyQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(await pbxDashboardService.getHourly(parsed.value));
  } catch (error) {
    req.log.error(error, "vos missed-hourly error");
    res.status(500).json({ error: "PBX hourly report is temporarily unavailable." });
  }
});

router.get("/vos/missed-daily", async (req, res) => {
  try {
    res.json(await pbxDashboardService.getDaily(parsePbxDailyQuery(req.query)));
  } catch (error) {
    req.log.error(error, "vos missed-daily error");
    res.status(500).json({ error: "PBX daily report is temporarily unavailable." });
  }
});

router.get("/vos/missed-breakdown", async (req, res) => {
  try {
    const parsed = parsePbxBreakdownQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(await pbxDashboardService.getBreakdown(req.user!, parsed.value));
  } catch (error) {
    req.log.error(error, "vos missed-breakdown error");
    res.status(500).json({ error: "PBX historical breakdown is temporarily unavailable." });
  }
});

router.get("/vos/callback-review", async (req, res) => {
  try {
    const parsed = parsePbxCallbackReviewQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(await pbxDashboardService.getCallbackReview(req.user!, parsed.value));
  } catch (error) {
    req.log.error(error, "vos callback-review error");
    res.status(500).json({ error: "PBX callback report is temporarily unavailable." });
  }
});

router.get("/vos/live", async (req, res) => {
  try {
    res.json(await pbxDashboardService.getLive(req.user!));
  } catch (error) {
    req.log.error(error, "vos live error");
    res.status(500).json({ error: "PBX live calls are temporarily unavailable." });
  }
});

router.get("/vos/debug/calls", requireRole("admin"), async (req, res) => {
  try {
    res.json(await pbxDiagnosticsService.getCalls(req.query as Record<string, string>));
  } catch (error) {
    req.log.error(error, "vos debug error");
    res.status(500).json({ error: "PBX diagnostic request failed." });
  }
});

router.get("/vos/debug/proxy", requireRole("admin"), async (req, res) => {
  try {
    res.json(await pbxDiagnosticsService.proxy(req.query["path"]));
  } catch (error) {
    if (error instanceof PbxDiagnosticPathError) {
      res.status(400).json({ error: error.message });
      return;
    }
    req.log.error(error, "vos debug proxy error");
    res.status(500).json({ error: "PBX diagnostic request failed." });
  }
});

export default router;
