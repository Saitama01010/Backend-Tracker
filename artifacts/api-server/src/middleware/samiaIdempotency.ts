import type { NextFunction, Request, Response } from "express";
import {
  completeAiReservation,
  failAiReservation,
  hashAiIdempotencyKey,
  hashAiRequest,
  reserveIdempotentAiRequest,
} from "../lib/aiRequestReservations.js";
import { logger } from "../lib/logger.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SAMIA_RESERVATION_SECONDS = 120;
const SAMIA_REUSE_SECONDS = 24 * 60 * 60;

export interface SamiaIdempotencyDependencies {
  reserve: typeof reserveIdempotentAiRequest;
  complete: typeof completeAiReservation;
  fail: typeof failAiReservation;
}

const defaultDependencies: SamiaIdempotencyDependencies = {
  reserve: reserveIdempotentAiRequest,
  complete: completeAiReservation,
  fail: failAiReservation,
};

export function createSamiaIdempotencyMiddleware(
  dependencies: SamiaIdempotencyDependencies = defaultDependencies,
) {
  return async function samiaIdempotency(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const rawKey = req.get("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY_PATTERN.test(rawKey)) {
      res
        .status(400)
        .json({ error: "A valid Idempotency-Key header is required" });
      return;
    }

    try {
      const reservation = await dependencies.reserve({
        feature: "samia_chat",
        scopeKey: String(req.user!.userId),
        idempotencyKey: hashAiIdempotencyKey(rawKey),
        requestHash: hashAiRequest(req.body),
        reservationSeconds: SAMIA_RESERVATION_SECONDS,
      });

      if (reservation.kind === "conflict") {
        res.status(409).json({
          error: "Idempotency-Key was already used for a different request",
        });
        return;
      }
      if (reservation.kind === "in_progress") {
        res.setHeader("Retry-After", String(reservation.retryAfter));
        res
          .status(409)
          .json({ error: "This Samia request is already processing" });
        return;
      }
      if (reservation.kind === "completed") {
        res.status(reservation.responseStatus).json(reservation.responseBody);
        return;
      }

      const originalJson = res.json.bind(res);
      let settled = false;
      res.json = ((body: unknown) => {
        if (settled) return res;
        settled = true;
        const responseStatus = res.statusCode;
        const responseBody =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : { result: body ?? null };
        const retryable =
          responseStatus === 409 ||
          responseStatus === 429 ||
          responseStatus >= 500;

        void (
          retryable
            ? dependencies.fail(reservation.id, `HTTP_${responseStatus}`)
            : dependencies.complete(
                reservation.id,
                responseStatus,
                responseBody,
                SAMIA_REUSE_SECONDS,
              )
        )
          .then(() => originalJson(body))
          .catch((error) => {
            logger.error(
              { err: error, feature: "samia_idempotency" },
              "Samia idempotency persistence failed",
            );
            res.status(503);
            originalJson({
              error: "Samia request persistence is temporarily unavailable",
            });
          });
        return res;
      }) as Response["json"];
      next();
    } catch (error) {
      logger.error(
        { err: error, feature: "samia_idempotency" },
        "Samia idempotency reservation failed",
      );
      res
        .status(503)
        .json({ error: "Samia request protection is temporarily unavailable" });
    }
  };
}

export const requireSamiaIdempotency = createSamiaIdempotencyMiddleware();
