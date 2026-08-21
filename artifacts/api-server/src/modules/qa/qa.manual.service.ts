import { canonicalAgentName } from "../../integrations/quo/sync.js";
import { AiRateLimitError, withDurableAiLimit } from "../../lib/aiRateLimit.js";
import {
  completeAiReservation,
  failAiReservation,
  hashAiIdempotencyKey,
  hashAiRequest,
  normalizeQaAgentKey,
  reserveQaAgentRun,
} from "../../lib/aiRequestReservations.js";
import { shouldReuseStoredReview } from "../../lib/qaPolicy.js";
import { getQuoCallArtifacts } from "../../lib/quoCall.js";
import { evaluateCall, QA_REVIEW_INTERVAL_DAYS } from "./qa.evaluation.service.js";
import { qaRepository, type QaReviewRecord } from "./qa.repository.js";

export type QaManualEvaluationOutcome = {
  status: 200 | 404 | 409 | 422 | 429 | 500 | 502;
  body: QaReviewRecord | { error: string; eligibleAt?: string };
  retryAfter?: number;
};

function agentKey(value: string | null | undefined): string {
  return normalizeQaAgentKey(canonicalAgentName(value) ?? value ?? "");
}

export class QaManualEvaluationService {
  async evaluate(input: {
    callId: string;
    force: boolean;
    rawIdempotencyKey: string | undefined;
    userId: number;
  }): Promise<QaManualEvaluationOutcome> {
    let reservationId: number | null = null;
    try {
      const existing = await qaRepository.getReview(input.callId);
      if (shouldReuseStoredReview(existing, input.force)) return { status: 200, body: existing! };

      const [call, artifacts] = await Promise.all([
        qaRepository.getCall(input.callId),
        getQuoCallArtifacts(input.callId),
      ]);
      if (!call && artifacts.status === "not_found") {
        return { status: 404, body: { error: "Call not found" } };
      }
      if (!call) {
        return {
          status: 404,
          body: { error: "Call metadata was not found in the synchronized QUO calls table" },
        };
      }
      if (artifacts.status !== "ready") {
        return { status: 409, body: { error: "QUO transcript is unavailable or still processing" } };
      }

      const agentName = canonicalAgentName(call.agentName);
      const key = agentKey(agentName);
      if (!agentName || !key || key === "unknown") {
        return { status: 422, body: { error: "Call has no authoritative QA agent identity" } };
      }
      const reservation = await reserveQaAgentRun({
        agentKey: key,
        agentName,
        callId: input.callId,
        idempotencyKey: hashAiIdempotencyKey(input.rawIdempotencyKey || `qa-call:${input.callId}`),
        requestHash: hashAiRequest({ callId: input.callId }),
        source: "manual_call_id",
        requestedByUserId: input.userId,
      });
      if (reservation.kind === "completed") {
        const completedReview = await qaRepository.getReview(input.callId);
        return completedReview
          ? { status: 200, body: completedReview }
          : { status: 409, body: { error: "QA was already completed for this agent" } };
      }
      if (reservation.kind === "in_progress") {
        return {
          status: 409,
          retryAfter: reservation.retryAfter,
          body: { error: "QA is already processing for this agent" },
        };
      }
      if (reservation.kind === "cooldown") {
        return {
          status: 409,
          retryAfter: Math.max(1, Math.ceil((reservation.eligibleAt.getTime() - Date.now()) / 1_000)),
          body: {
            error: `QA is limited to one completed or reserved run per agent in any rolling ${QA_REVIEW_INTERVAL_DAYS}-day period`,
            eligibleAt: reservation.eligibleAt.toISOString(),
          },
        };
      }
      if (reservation.kind === "conflict") {
        return {
          status: 409,
          body: { error: "Idempotency-Key was already used for a different QA request" },
        };
      }
      reservationId = reservation.id;

      const review = await withDurableAiLimit({
        feature: "qa_manual",
        userId: input.userId,
        perMinute: 3,
        perDay: 20,
      }, () => evaluateCall(input.callId, {
        source: "manual_call_id",
        userId: input.userId,
        artifacts,
      }));
      if (!review) {
        await failAiReservation(reservationId, "QA_RESULT_INVALID");
        reservationId = null;
        return {
          status: 422,
          body: { error: "Call is not QA-eligible or Claude returned an invalid evaluation" },
        };
      }
      await completeAiReservation(
        reservationId,
        200,
        { callId: input.callId },
        QA_REVIEW_INTERVAL_DAYS * 24 * 60 * 60,
      );
      reservationId = null;
      return { status: 200, body: review };
    } catch (error) {
      if (reservationId !== null) {
        await failAiReservation(reservationId, "QA_EVALUATION_FAILED").catch(() => undefined);
      }
      if (error instanceof AiRateLimitError) {
        return {
          status: 429,
          retryAfter: error.retryAfter,
          body: { error: "Manual QA evaluation limit reached" },
        };
      }
      if ((error as Error)?.message?.includes("ANTHROPIC_API_KEY")) {
        return {
          status: 500,
          body: { error: "QA is missing server-side Anthropic configuration" },
        };
      }
      return { status: 502, body: { error: "QA evaluation failed" } };
    }
  }
}

export const qaManualEvaluationService = new QaManualEvaluationService();
