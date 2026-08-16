import { canonicalAgentName } from "../../integrations/quo/sync.js";
import { AiRateLimitError, withDatabaseLease, withDurableAiLimit } from "../../lib/aiRateLimit.js";
import {
  completeAiReservation,
  failAiReservation,
  hashAiIdempotencyKey,
  hashAiRequest,
  normalizeQaAgentKey,
  reserveQaAgentRun,
  type QaReservationDecision,
} from "../../lib/aiRequestReservations.js";
import { postgresBackgroundJobStore } from "../../lib/backgroundJobStore.js";
import { addCalendarDays, calendarDateParts, formatCalendarDate, startOfBusinessDay } from "../../lib/businessTime.js";
import { planWeeklyQaAssignments } from "../../lib/databasePerformance.js";
import { manualJobKey, runNextBackgroundJob, scheduledJobKey } from "../../lib/durableBackgroundJobs.js";
import { stableEligibleCalls } from "../../lib/qaPolicy.js";
import { getQuoCallArtifacts, type QuoCallArtifacts } from "../../lib/quoCall.js";
import {
  anthropicErrorStatus,
  evaluateCall,
  QA_MIN_CALL_SECONDS,
  QA_REVIEW_INTERVAL_DAYS,
} from "./qa.evaluation.service.js";
import { qaRepository, type QaBiweeklyRunRecord } from "./qa.repository.js";

export interface QaBiweeklyResult {
  runId: number;
  evaluated: Array<{ agent: string; callId: string }>;
  skipped: Array<{ agent: string; reason: string }>;
  errors: Array<{ agent: string; reason: string }>;
}

function agentKey(value: string | null | undefined): string {
  return normalizeQaAgentKey(canonicalAgentName(value) ?? value ?? "");
}

function qaReservationReason(decision: Exclude<QaReservationDecision, { kind: "reserved" }>): string {
  if (decision.kind === "completed" || decision.kind === "cooldown") {
    return `QA already completed within the rolling ${QA_REVIEW_INTERVAL_DAYS}-day window`;
  }
  if (decision.kind === "in_progress") return "QA is already reserved for this agent";
  return "QA idempotency key conflicts with another request";
}

export async function runBiweeklyQa(
  trigger: "cron" | "admin",
  signal?: AbortSignal,
): Promise<QaBiweeklyResult> {
  return withDatabaseLease("qa_auto_biweekly", async () => {
    signal?.throwIfAborted();
    const run = await qaRepository.createBiweeklyRun(trigger);
    const result: QaBiweeklyResult = { runId: run?.id ?? 0, evaluated: [], skipped: [], errors: [] };
    try {
      const cutoff = new Date(Date.now() - QA_REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
      const { roster, recentReviews, candidates, reviewed } = await qaRepository
        .loadBiweeklyInputs(cutoff, QA_MIN_CALL_SECONDS);
      const recentlyReviewed = new Set(recentReviews.map((row) => agentKey(row.agentName)));
      const reviewedCalls = new Set(reviewed.map((row) => row.id));
      const sortedCandidates = stableEligibleCalls(candidates, reviewedCalls, QA_MIN_CALL_SECONDS);

      for (const rosterAgent of [...roster].sort((a, b) => a.name.localeCompare(b.name))) {
        signal?.throwIfAborted();
        const key = agentKey(rosterAgent.name);
        if (recentlyReviewed.has(key)) {
          result.skipped.push({
            agent: rosterAgent.name,
            reason: `QA review already exists within ${QA_REVIEW_INTERVAL_DAYS} days`,
          });
          continue;
        }

        const agentCandidates = sortedCandidates.filter((call) => agentKey(call.agentName) === key);
        if (agentCandidates.length === 0) {
          result.skipped.push({
            agent: rosterAgent.name,
            reason: `no unreviewed completed call of at least ${QA_MIN_CALL_SECONDS} seconds`,
          });
          continue;
        }

        let selected: (typeof agentCandidates)[number] | null = null;
        let artifacts: QuoCallArtifacts | null = null;
        for (const candidate of agentCandidates) {
          signal?.throwIfAborted();
          const candidateArtifacts = await getQuoCallArtifacts(candidate.id);
          if (candidateArtifacts.status === "ready") {
            selected = candidate;
            artifacts = candidateArtifacts;
            break;
          }
        }
        if (!selected || !artifacts) {
          result.skipped.push({ agent: rosterAgent.name, reason: "no eligible call has a real QUO transcript" });
          continue;
        }

        const reservation = await reserveQaAgentRun({
          agentKey: key,
          agentName: rosterAgent.name,
          callId: selected.id,
          idempotencyKey: hashAiIdempotencyKey(`qa-call:${selected.id}`),
          requestHash: hashAiRequest({ callId: selected.id }),
          source: "auto_biweekly",
          requestedByUserId: null,
        });
        if (reservation.kind !== "reserved") {
          result.skipped.push({ agent: rosterAgent.name, reason: qaReservationReason(reservation) });
          continue;
        }

        try {
          const review = await evaluateCall(selected.id, {
            source: "auto_biweekly",
            userId: 0,
            artifacts,
          });
          if (review) {
            await completeAiReservation(
              reservation.id,
              200,
              { callId: selected.id },
              QA_REVIEW_INTERVAL_DAYS * 24 * 60 * 60,
            );
            result.evaluated.push({ agent: rosterAgent.name, callId: selected.id });
            recentlyReviewed.add(key);
          } else {
            await failAiReservation(reservation.id, "QA_RESULT_INVALID");
            result.skipped.push({ agent: rosterAgent.name, reason: "Claude result failed server-side validation" });
          }
        } catch (error) {
          await failAiReservation(reservation.id, "QA_EVALUATION_FAILED").catch(() => undefined);
          result.errors.push({
            agent: rosterAgent.name,
            reason: `evaluation failed (${anthropicErrorStatus(error) ?? "internal"})`,
          });
        }
      }

      if (run) await qaRepository.completeBiweeklyRun(run.id, result);
      return result;
    } catch (error) {
      if (run) await qaRepository.failBiweeklyRun(run.id, result).catch(() => undefined);
      throw error;
    }
  });
}

function currentLAWeekStart(): Date {
  const today = formatCalendarDate(new Date());
  const { year, month, day } = calendarDateParts(today);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return startOfBusinessDay(addCalendarDays(today, -daysSinceMonday));
}

export async function runWeeklyAssignment(): Promise<{ created: number; agents: number }> {
  const weekStart = currentLAWeekStart();
  const lookback = startOfBusinessDay(addCalendarDays(formatCalendarDate(weekStart), -7));
  const reviews = await qaRepository.listReviewsSince(lookback);
  const agents = [...new Set(reviews.map((review) => review.agentName))];
  const existingTasks = agents.length > 0
    ? await qaRepository.listManagerTasksForAgents(agents)
    : [];
  const plan = planWeeklyQaAssignments(reviews, existingTasks, weekStart);
  const inserted = plan.picks.length > 0
    ? await qaRepository.insertManagerTasks(plan.picks)
    : [];
  return { created: inserted.length, agents: plan.agents };
}

export type QaAdminRunOutcome =
  | { kind: "completed"; result: QaBiweeklyResult }
  | { kind: "rate_limited"; retryAfter: number }
  | { kind: "active"; retryAfter: number; activeRun: QaBiweeklyRunRecord | null }
  | { kind: "failed" };

export async function runAdminBiweeklyQa(userId: number): Promise<QaAdminRunOutcome> {
  try {
    const result = await withDurableAiLimit(
      { feature: "qa_admin_run", userId, perMinute: 1, perDay: 10 },
      async () => {
        const enqueued = await postgresBackgroundJobStore.enqueue({
          jobType: "qa_biweekly",
          idempotencyKey: manualJobKey("qa_biweekly", userId),
          requestedByUserId: userId,
          priority: 100,
          maxAttempts: 3,
        });
        const workerId = `manual:qa:${userId}:${Date.now()}`;
        const run = await runNextBackgroundJob(postgresBackgroundJobStore, {
          qa_biweekly: async (_job, { signal }) => {
            signal.throwIfAborted();
            return { ...(await runBiweeklyQa("admin", signal)) };
          },
        }, {
          workerId,
          jobId: enqueued.job.id,
          leaseMs: 6 * 60_000,
          timeoutMs: 4 * 60_000,
          retryAfterMs: 60_000,
        });
        const stored = await postgresBackgroundJobStore.get(enqueued.job.id);
        if (stored?.status === "completed" && stored.result) return stored.result as unknown as QaBiweeklyResult;
        if (run.outcome === "idle" || stored?.status === "running") throw new AiRateLimitError("lease", 60);
        throw new Error(stored?.lastErrorCode ?? "qa_job_failed");
      },
    );
    return { kind: "completed", result };
  } catch (error) {
    if (error instanceof AiRateLimitError) {
      if (error.reason !== "lease") return { kind: "rate_limited", retryAfter: error.retryAfter };
      return {
        kind: "active",
        retryAfter: error.retryAfter,
        activeRun: await qaRepository.getActiveBiweeklyRun(),
      };
    }
    return { kind: "failed" };
  }
}

export async function enqueueScheduledBiweeklyQa(now = new Date()): Promise<{
  ok: true;
  queued: boolean;
  jobId: number;
}> {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const enqueued = await postgresBackgroundJobStore.enqueue({
    jobType: "qa_biweekly",
    idempotencyKey: scheduledJobKey("qa_biweekly", day),
    priority: 30,
    maxAttempts: 3,
  });
  return { ok: true, queued: enqueued.created, jobId: enqueued.job.id };
}

export function getLatestQaRun(): Promise<QaBiweeklyRunRecord | null> {
  return qaRepository.getLatestBiweeklyRun();
}
