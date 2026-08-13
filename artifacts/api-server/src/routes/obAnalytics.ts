import { Router, type IRouter } from "express";
import {
  buildOnboardingAnalyticsWorkbook,
  computeOnboardingAnalytics,
} from "../modules/onboarding/analytics.js";
import { requireAuth } from "../middleware/auth.js";
import {
  setPrivateDownloadHeaders,
  validateOptionalWorkflowRange,
} from "../lib/sensitiveWorkflowPolicy.js";

const router: IRouter = Router();
router.use("/ob-analytics", requireAuth);

router.get("/ob-analytics", async (req, res) => {
  try {
    const from = req.query["from"] as string | undefined;
    const to = req.query["to"] as string | undefined;
    const requestedRange = validateOptionalWorkflowRange(from, to);
    if (!requestedRange.ok) {
      res.status(400).json({ error: requestedRange.error });
      return;
    }
    res.json(await computeOnboardingAnalytics(from, to));
  } catch (error) {
    req.log.error(error, "ob-analytics error");
    res.status(500).json({ error: "Unable to load onboarding analytics." });
  }
});

router.get("/ob-analytics/download", async (req, res) => {
  try {
    const from = req.query["from"] as string | undefined;
    const to = req.query["to"] as string | undefined;
    const requestedRange = validateOptionalWorkflowRange(from, to);
    if (!requestedRange.ok) {
      res.status(400).json({ error: requestedRange.error });
      return;
    }
    const data = await computeOnboardingAnalytics(from, to);
    const workbook = await buildOnboardingAnalyticsWorkbook(data);
    const buffer = await workbook.xlsx.writeBuffer();
    setPrivateDownloadHeaders(res, "Onboarding_Team_Analysis.xlsx");
    res.end(Buffer.from(buffer));
  } catch (error) {
    req.log.error(error, "ob-analytics download error");
    res.status(500).json({ error: "Unable to generate onboarding analytics." });
  }
});

export default router;
