export const BACKGROUND_JOB_TYPES = [
  "integration_live_refresh",
  "quo_sync",
  "vos_backfill",
  "onboarding_report_refresh",
  "live_transfer_refresh",
  "qa_biweekly",
  "qa_weekly_assignment",
  "ai_reservation_cleanup",
] as const;

export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number];
export type BackgroundJobStatus = "queued" | "running" | "retry" | "completed" | "failed";

export interface DurableBackgroundJob {
  id: number;
  jobType: BackgroundJobType;
  idempotencyKey: string;
  status: BackgroundJobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  priority: number;
  attempts: number;
  maxAttempts: number;
  requestedByUserId: number | null;
  runAfter: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface EnqueueBackgroundJob {
  jobType: BackgroundJobType;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  requestedByUserId?: number;
  runAfter?: Date;
}

export interface EnqueueResult {
  job: DurableBackgroundJob;
  created: boolean;
}

export interface DurableBackgroundJobStore {
  enqueue(input: EnqueueBackgroundJob): Promise<EnqueueResult>;
  claim(workerId: string, leaseMs: number, now?: Date, jobId?: number): Promise<DurableBackgroundJob | null>;
  complete(jobId: number, workerId: string, result: Record<string, unknown>): Promise<boolean>;
  fail(jobId: number, workerId: string, errorCode: string, retryAfterMs: number): Promise<boolean>;
  get(jobId: number): Promise<DurableBackgroundJob | null>;
  list(options?: {
    status?: BackgroundJobStatus;
    jobType?: BackgroundJobType;
    limit?: number;
  }): Promise<DurableBackgroundJob[]>;
  findActive(jobType: BackgroundJobType): Promise<DurableBackgroundJob | null>;
}

export interface BackgroundJobContext {
  signal: AbortSignal;
  attempt: number;
}

export type BackgroundJobHandler = (
  job: DurableBackgroundJob,
  context: BackgroundJobContext,
) => Promise<Record<string, unknown> | void>;

export type BackgroundJobHandlers = Partial<Record<BackgroundJobType, BackgroundJobHandler>>;

export interface RunBackgroundJobOptions {
  workerId: string;
  leaseMs?: number;
  timeoutMs?: number;
  retryAfterMs?: number;
  now?: Date;
  jobId?: number;
}

export type BackgroundJobRunResult =
  | { outcome: "idle" }
  | { outcome: "completed"; job: DurableBackgroundJob }
  | { outcome: "retry" | "failed"; job: DurableBackgroundJob; errorCode: string };

export class BackgroundJobTimeoutError extends Error {
  constructor() {
    super("background_job_timeout");
    this.name = "BackgroundJobTimeoutError";
  }
}

export function sanitizedBackgroundJobErrorCode(error: unknown): string {
  if (error instanceof BackgroundJobTimeoutError) return "timeout";
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_]{1,64}$/i.test(candidate) ? candidate.toLowerCase() : "processing_failed";
}

export function scheduledJobKey(jobType: BackgroundJobType, bucket: string): string {
  if (!/^[a-z0-9:_-]{1,80}$/i.test(bucket)) throw new Error("invalid_job_bucket");
  return `schedule:${jobType}:${bucket}`;
}

export function manualJobKey(
  jobType: BackgroundJobType,
  userId: number,
  now = new Date(),
  bucketMs = 60_000,
): string {
  return `manual:${jobType}:${userId}:${Math.floor(now.getTime() / bucketMs)}`;
}

export async function runNextBackgroundJob(
  store: DurableBackgroundJobStore,
  handlers: BackgroundJobHandlers,
  options: RunBackgroundJobOptions,
): Promise<BackgroundJobRunResult> {
  const leaseMs = options.leaseMs ?? 6 * 60_000;
  const timeoutMs = options.timeoutMs ?? 4 * 60_000;
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const job = await store.claim(options.workerId, leaseMs, options.now, options.jobId);
  if (!job) return { outcome: "idle" };

  const handler = handlers[job.jobType];
  if (!handler) {
    const errorCode = "handler_missing";
    await store.fail(job.id, options.workerId, errorCode, retryAfterMs);
    return { outcome: job.attempts >= job.maxAttempts ? "failed" : "retry", job, errorCode };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BackgroundJobTimeoutError());
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      handler(job, { signal: controller.signal, attempt: job.attempts }),
      timeout,
    ]);
    const completed = await store.complete(job.id, options.workerId, result ?? {});
    if (!completed) throw new Error("job_lease_lost");
    return { outcome: "completed", job };
  } catch (error) {
    controller.abort();
    const errorCode = sanitizedBackgroundJobErrorCode(error);
    const retryDelay = error instanceof BackgroundJobTimeoutError
      ? Math.max(retryAfterMs, leaseMs)
      : retryAfterMs;
    await store.fail(job.id, options.workerId, errorCode, retryDelay).catch(() => false);
    return { outcome: job.attempts >= job.maxAttempts ? "failed" : "retry", job, errorCode };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
