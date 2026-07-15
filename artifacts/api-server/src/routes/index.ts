import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { authorizeApiDateParameters, authorizeApiRoute } from "./authorizationPolicy.js";
import { isPublicApiRoute } from "./apiPolicy.js";
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
import qaRouter from "./qa";
import obReportRouter from "./obReport";
import obAnalyticsRouter from "./obAnalytics";
import liveTransfersRouter from "./liveTransfers";

const router: IRouter = Router();

function defaultPrivateApiAuthentication(req: Request, res: Response, next: NextFunction) {
  if (isPublicApiRoute(req.method, req.path)) {
    next();
    return;
  }
  void requireAuth(req, res, next);
}

function defaultPrivateApiAuthorization(req: Request, res: Response, next: NextFunction) {
  const decision = authorizeApiRoute(req.method, req.path, req.user);
  const datesAllowed = authorizeApiDateParameters(
    req.method,
    req.path,
    req.user,
    req.query as Record<string, unknown>,
    (req.body ?? {}) as Record<string, unknown>,
  );
  if (decision.allowed && datesAllowed) {
    next();
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.status(403).json({ error: "Forbidden" });
}

router.use(defaultPrivateApiAuthentication);
router.use(defaultPrivateApiAuthorization);

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

router.use(teamAgentsRouter);

export default router;
