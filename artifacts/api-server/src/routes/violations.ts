import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { parseViolationsQuery } from "../modules/violations/violations.schemas.js";
import {
  ViolationsServiceError,
  violationsService,
} from "../modules/violations/violations.service.js";

const router = Router();
router.use("/violations", requireAuth);

function serviceError(
  error: unknown,
  response: Response,
  request: Request,
  logMessage: string,
  publicMessage: string,
) {
  if (error instanceof ViolationsServiceError) {
    return response.status(error.status).json(error.response);
  }
  request.log.error(error, logMessage);
  return response.status(500).json({ error: publicMessage });
}

/** GET /api/violations?from=YYYY-MM-DD&to=YYYY-MM-DD */
router.get("/violations", async (req, res) => {
  try {
    const result = await violationsService.getDashboard({
      actor: req.user!,
      query: parseViolationsQuery(req.query),
    });
    return res.json(result);
  } catch (error) {
    return serviceError(error, res, req, "violations error", "Unable to load violations.");
  }
});

/** POST /api/violations/verify — mark a violation verified (idempotent) */
router.post("/violations/verify", async (req, res) => {
  try {
    return res.json(await violationsService.verify({ actor: req.user!, body: req.body }));
  } catch (error) {
    return serviceError(error, res, req, "violations/verify POST error", "Unable to verify violation.");
  }
});

/** DELETE /api/violations/verify — unverify */
router.delete("/violations/verify", requireRole("admin"), async (req, res) => {
  try {
    return res.json(await violationsService.removeVerification(req.body));
  } catch (error) {
    return serviceError(
      error,
      res,
      req,
      "violations/verify DELETE error",
      "Unable to remove violation verification.",
    );
  }
});

/** GET /api/violations/verified — all persisted verified violations */
router.get("/violations/verified", async (req, res) => {
  try {
    return res.json(await violationsService.listVerified(req.user!));
  } catch (error) {
    return serviceError(
      error,
      res,
      req,
      "violations/verified GET error",
      "Unable to load verified violations.",
    );
  }
});

export default router;
