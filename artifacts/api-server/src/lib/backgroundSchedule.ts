import {
  scheduledJobKey,
  type BackgroundJobType,
  type EnqueueBackgroundJob,
} from "./durableBackgroundJobs.js";
import schedulerContract from "../../../../config/scheduler-contract.json" with { type: "json" };

type RawScheduledTask = (typeof schedulerContract.tasks)[number];
type ScheduledTask = Omit<RawScheduledTask, "jobType"> & { jobType: BackgroundJobType };

const scheduledTasks = schedulerContract.tasks as readonly ScheduledTask[];

function task(jobType: BackgroundJobType): ScheduledTask {
  const definition = scheduledTasks.find((candidate) => candidate.jobType === jobType);
  if (!definition) throw new Error(`missing_schedule_contract:${jobType}`);
  return definition;
}

function job(definition: ScheduledTask, bucket: string): EnqueueBackgroundJob {
  return {
    jobType: definition.jobType,
    idempotencyKey: scheduledJobKey(definition.jobType, bucket),
    priority: definition.priority,
    maxAttempts: definition.maxAttempts,
  };
}

export const NATIVE_CRON_SCHEDULE = schedulerContract.nativeCron.schedule;
export const NATIVE_CRON_UTC_HOUR = Number(NATIVE_CRON_SCHEDULE.split(" ")[1]);
export const HIGH_FREQUENCY_MAX_DELAY_MINUTES = Math.min(
  ...scheduledTasks
    .filter((definition) => definition.scheduleClass === "high-frequency")
    .map((definition) => definition.maximumDelayMinutes),
);

if (!Number.isInteger(NATIVE_CRON_UTC_HOUR) || NATIVE_CRON_UTC_HOUR < 0 || NATIVE_CRON_UTC_HOUR > 23) {
  throw new Error("invalid_native_cron_contract");
}

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
    job(task("integration_live_refresh"), minute),
    job(task("quo_sync"), fifteenMinuteBucket),
  ];

  if (now.getUTCHours() === NATIVE_CRON_UTC_HOUR) {
    const day = compactUtcDay(now);
    jobs.push(job(task("qa_biweekly"), day));
    jobs.push(job(task("vos_backfill"), day));
    jobs.push(job(task("ai_reservation_cleanup"), day));
    if (now.getUTCDay() === 1) {
      jobs.push(job(task("qa_weekly_assignment"), day));
    }
  }
  return jobs;
}
