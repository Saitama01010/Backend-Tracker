import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quoRouter from "./quo";
import quoWebhookRouter from "./quoWebhook";
import attendanceRouter from "./attendance";
import authRouter from "./auth";
import usersRouter from "./users";
import vosRouter from "./vos";
import samiaRouter from "./samia";
import blockedNumbersRouter from "./blockedNumbers";
import violationsRouter from "./violations";
import readymodeRouter from "./readymode";
import nsfReadymodeRouter from "./nsfReadymode";
import csvProxyRouter from "./csvProxy";
import sheetsRouter from "./sheets";
import breaksRouter from "./breaks";
import teamAgentsRouter from "./teamAgents";
import qaRouter, { startQaBackgroundProcessor } from "./qa";
import obReportRouter from "./obReport";
import obAnalyticsRouter from "./obAnalytics";
import liveTransfersRouter, { startLiveTransfersBackground } from "./liveTransfers";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(quoWebhookRouter);
router.use(quoRouter);
router.use(attendanceRouter);
router.use(vosRouter);
router.use(samiaRouter);
router.use(blockedNumbersRouter);
router.use(violationsRouter);
router.use(breaksRouter);
router.use(readymodeRouter);
router.use(nsfReadymodeRouter);
router.use(csvProxyRouter);
router.use(sheetsRouter);
router.use(qaRouter);
router.use(obReportRouter);
router.use(obAnalyticsRouter);
router.use(liveTransfersRouter);

// Kick off background QA processor (evaluates new retention calls every 5 min).
startQaBackgroundProcessor();
// Kick off background live-transfer classifier (Aspire/Resync inbound transfers).
startLiveTransfersBackground();
router.use(teamAgentsRouter);

export default router;
