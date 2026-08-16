import { logger } from "./logger.js";
import type { BackgroundJobHandlers } from "./durableBackgroundJobs.js";
import { runLivePoll } from "../modules/retention/retention.quo.live.service.js";
import { runScheduledQuoSync, runSync } from "../integrations/quo/sync.js";
import { refreshCallHistory } from "../routes/vos.js";
import { runOnboardingReportRefresh } from "../modules/onboarding/report.js";
import { runLiveTransferRefresh } from "../modules/transfers/liveTransfers.js";
import { runBiweeklyQa, runWeeklyAssignment } from "../modules/qa/qa.jobs.service.js";
import { withDatabaseLease } from "./aiRateLimit.js";
import { cleanupExpiredAiReservations } from "./aiReservationCleanup.js";

function requestedRange(payload: Record<string, unknown>): { from: Date; to: Date } | null {
  if (typeof payload["from"] !== "string" || typeof payload["to"] !== "string") return null;
  const from = new Date(payload["from"]);
  const to = new Date(payload["to"]);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error("invalid_job_payload");
  }
  if (to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1000) throw new Error("invalid_job_payload");
  return { from, to };
}

export const backgroundJobHandlers: BackgroundJobHandlers = {
  async integration_live_refresh(_job, { signal }) {
    const [quo] = await Promise.all([
      runLivePoll(signal),
      withDatabaseLease("vos_call_history_refresh", () => refreshCallHistory(logger, { signal })),
    ]);
    return { quoActive: quo.active.length, pbxRefreshed: true };
  },

  async quo_sync(job, { signal }) {
    const range = requestedRange(job.payload);
    const result = range
      ? await runSync(range.from, range.to, { signal })
      : await runScheduledQuoSync(signal);
    return { inserted: result.inserted, errors: result.errors };
  },

  async vos_backfill(_job, { signal }) {
    await withDatabaseLease(
      "vos_call_history_refresh",
      () => refreshCallHistory(logger, { deepBackfill: true, signal }),
    );
    return { backfilled: true };
  },

  async onboarding_report_refresh(_job, { signal }) {
    await runOnboardingReportRefresh(signal);
    return { refreshed: true };
  },

  async live_transfer_refresh(_job, { signal }) {
    await runLiveTransferRefresh(signal);
    return { refreshed: true };
  },

  async qa_biweekly(job, { signal }) {
    signal.throwIfAborted();
    const result = await runBiweeklyQa(job.requestedByUserId ? "admin" : "cron", signal);
    signal.throwIfAborted();
    return { ...result };
  },

  async qa_weekly_assignment(_job, { signal }) {
    signal.throwIfAborted();
    return runWeeklyAssignment();
  },

  async ai_reservation_cleanup(_job, { signal }) {
    signal.throwIfAborted();
    const result = await cleanupExpiredAiReservations();
    signal.throwIfAborted();
    return result;
  },
};
