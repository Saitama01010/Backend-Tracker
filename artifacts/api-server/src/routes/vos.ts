import { Router } from "express";
import { approvedVosDebugPath } from "../lib/externalIntegrationPolicy.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { fetchPbxJson, type VosCallRaw } from "../integrations/pbx/client.js";
import { retentionPbxService } from "../modules/retention/retention.pbx.service.js";
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
import { pbxMissedReportingService } from "../modules/pbx/pbx.missed.service.js";
import { pbxNoCallbackService } from "../modules/pbx/pbx.no-callback.service.js";
import { pbxRefreshService } from "../modules/pbx/pbx.refresh.service.js";
import {
  hydratePbxState,
  pbxRuntimeState,
} from "../modules/pbx/pbx.state.js";

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
    await hydratePbxState();
    const payload = await retentionPbxService.getStats({
      actor: req.user!,
      cache: {
        callHistory: pbxRuntimeState.callHistory,
        fetchedAt: pbxRuntimeState.fetchedAt,
        ringGroupMissed: pbxRuntimeState.ringGroupMissed,
      },
      log: req.log,
    });
    res.json(payload);
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
    res.json(await pbxMissedReportingService.getHourly({
      query: parsed.value,
      internalNumbers: pbxRuntimeState.internalNumbers,
      livePbxByHour: pbxRuntimeState.cumulativeMissedByHour,
    }));
  } catch (error) {
    req.log.error(error, "vos missed-hourly error");
    res.status(500).json({ error: "PBX hourly report is temporarily unavailable." });
  }
});

router.get("/vos/missed-daily", async (req, res) => {
  try {
    res.json(await pbxMissedReportingService.getDaily({
      query: parsePbxDailyQuery(req.query),
      internalNumbers: pbxRuntimeState.internalNumbers,
      liveRingGroupMissed: pbxRuntimeState.ringGroupMissed,
      ringGroupNames: pbxRuntimeState.ringGroupNames,
    }));
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
    res.json(await pbxMissedReportingService.getBreakdown({
      actor: req.user!,
      query: parsed.value,
      internalNumbers: pbxRuntimeState.internalNumbers,
    }));
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
    res.json(await pbxMissedReportingService.getCallbackReview({
      actor: req.user!,
      query: parsed.value,
      internalNumbers: pbxRuntimeState.internalNumbers,
    }));
  } catch (error) {
    req.log.error(error, "vos callback-review error");
    res.status(500).json({ error: "PBX callback report is temporarily unavailable." });
  }
});

router.get("/vos/live", async (req, res) => {
  try {
    res.json(await retentionPbxService.getLive(req.user!));
  } catch (error) {
    req.log.error(error, "vos live error");
    res.status(500).json({ error: "PBX live calls are temporarily unavailable." });
  }
});

router.get("/vos/debug/calls", requireRole("admin"), async (req, res) => {
  try {
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    const data = await fetchPbxJson<{ calls: VosCallRaw[]; total: number }>(
      `/api/calls${query ? `?${query}` : ""}`,
    );
    res.json({ total: data.total, calls: data.calls });
  } catch (error) {
    req.log.error(error, "vos debug error");
    res.status(500).json({ error: "PBX diagnostic request failed." });
  }
});

router.get("/vos/debug/proxy", requireRole("admin"), async (req, res) => {
  try {
    const path = approvedVosDebugPath(req.query["path"] ?? "/api/calls?limit=1");
    if (!path) {
      res.status(400).json({ error: "PBX diagnostic path is not approved." });
      return;
    }
    res.json(await fetchPbxJson<unknown>(path));
  } catch (error) {
    req.log.error(error, "vos debug proxy error");
    res.status(500).json({ error: "PBX diagnostic request failed." });
  }
});

export default router;
