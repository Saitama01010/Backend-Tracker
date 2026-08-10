import { scheduledJobKey, type EnqueueBackgroundJob } from "./durableBackgroundJobs.js";

function compactUtcMinute(now: Date): string {
  return now.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}

function compactUtcDay(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

export function dueScheduledJobs(now = new Date()): EnqueueBackgroundJob[] {
  const minute = compactUtcMinute(now);
  const fifteenMinuteBucket = `${compactUtcDay(now)}${String(now.getUTCHours()).padStart(2, "0")}${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, "0")}`;
  const jobs: EnqueueBackgroundJob[] = [
    {
      jobType: "integration_live_refresh",
      idempotencyKey: scheduledJobKey("integration_live_refresh", minute),
      priority: 10,
      maxAttempts: 4,
    },
    {
      jobType: "quo_sync",
      idempotencyKey: scheduledJobKey("quo_sync", fifteenMinuteBucket),
      priority: 20,
      maxAttempts: 4,
    },
  ];

  if (now.getUTCHours() === 9) {
    const day = compactUtcDay(now);
    jobs.push({
      jobType: "qa_biweekly",
      idempotencyKey: scheduledJobKey("qa_biweekly", day),
      priority: 30,
      maxAttempts: 3,
    });
    jobs.push({
      jobType: "vos_backfill",
      idempotencyKey: scheduledJobKey("vos_backfill", day),
      priority: 5,
      maxAttempts: 3,
    });
    if (now.getUTCDay() === 1) {
      jobs.push({
        jobType: "qa_weekly_assignment",
        idempotencyKey: scheduledJobKey("qa_weekly_assignment", day),
        priority: 25,
        maxAttempts: 3,
      });
    }
  }
  return jobs;
}
