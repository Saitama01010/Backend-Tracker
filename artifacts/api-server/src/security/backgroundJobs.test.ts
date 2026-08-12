import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  dueScheduledJobs,
  NATIVE_CRON_SCHEDULE,
  NATIVE_CRON_UTC_HOUR,
} from "../lib/backgroundSchedule.js";
import { validCronAuthorization } from "../lib/cronAuth.js";
import {
  manualJobKey,
  runNextBackgroundJob,
  sanitizedBackgroundJobErrorCode,
  type BackgroundJobType,
  type DurableBackgroundJob,
  type DurableBackgroundJobStore,
  type EnqueueBackgroundJob,
  type EnqueueResult,
} from "../lib/durableBackgroundJobs.js";

function jobFrom(input: EnqueueBackgroundJob, id: number, now: Date): DurableBackgroundJob {
  return {
    id,
    jobType: input.jobType,
    idempotencyKey: input.idempotencyKey,
    status: "queued",
    payload: input.payload ?? {},
    result: null,
    priority: input.priority ?? 0,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    requestedByUserId: input.requestedByUserId ?? null,
    runAfter: input.runAfter ?? now,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
}

class FakeJobStore implements DurableBackgroundJobStore {
  readonly jobs = new Map<number, DurableBackgroundJob>();
  readonly byKey = new Map<string, number>();
  private nextId = 1;
  private clock = new Date("2026-08-10T09:00:00.000Z");

  async enqueue(input: EnqueueBackgroundJob): Promise<EnqueueResult> {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) return { job: this.jobs.get(existingId)!, created: false };
    const job = jobFrom(input, this.nextId++, this.clock);
    this.jobs.set(job.id, job);
    this.byKey.set(job.idempotencyKey, job.id);
    return { job, created: true };
  }

  async claim(workerId: string, leaseMs: number, now = this.clock, jobId?: number): Promise<DurableBackgroundJob | null> {
    this.clock = now;
    const activeTypes = new Set(
      [...this.jobs.values()]
        .filter((job) => job.status === "running" && (job.leaseExpiresAt?.getTime() ?? 0) > now.getTime())
        .map((job) => job.jobType),
    );
    const candidate = [...this.jobs.values()]
      .filter((job) => !jobId || job.id === jobId)
      .filter((job) => job.attempts < job.maxAttempts)
      .filter((job) => (job.status === "queued" || job.status === "retry")
        ? job.runAfter <= now
        : job.status === "running" && (job.leaseExpiresAt?.getTime() ?? Infinity) <= now.getTime())
      .filter((job) => job.status === "running" || !activeTypes.has(job.jobType))
      .sort((a, b) => b.priority - a.priority || a.runAfter.getTime() - b.runAfter.getTime() || a.id - b.id)[0];
    if (!candidate) return null;
    candidate.status = "running";
    candidate.attempts += 1;
    candidate.leaseOwner = workerId;
    candidate.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    candidate.startedAt ??= now;
    candidate.updatedAt = now;
    candidate.lastErrorCode = null;
    return { ...candidate };
  }

  async complete(jobId: number, workerId: string, result: Record<string, unknown>): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.leaseOwner !== workerId) return false;
    job.status = "completed";
    job.result = result;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.finishedAt = this.clock;
    job.updatedAt = this.clock;
    return true;
  }

  async fail(jobId: number, workerId: string, errorCode: string, retryAfterMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.leaseOwner !== workerId) return false;
    job.status = job.attempts < job.maxAttempts ? "retry" : "failed";
    job.runAfter = new Date(this.clock.getTime() + retryAfterMs);
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.lastErrorCode = errorCode;
    job.finishedAt = job.status === "failed" ? this.clock : null;
    job.updatedAt = this.clock;
    return true;
  }

  async get(jobId: number): Promise<DurableBackgroundJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async list(options: {
    status?: DurableBackgroundJob["status"];
    jobType?: BackgroundJobType;
    limit?: number;
  } = {}): Promise<DurableBackgroundJob[]> {
    return [...this.jobs.values()]
      .filter((job) => !options.status || job.status === options.status)
      .filter((job) => !options.jobType || job.jobType === options.jobType)
      .slice(0, options.limit ?? 50);
  }

  async findActive(type: BackgroundJobType): Promise<DurableBackgroundJob | null> {
    return [...this.jobs.values()].find((job) => job.jobType === type
      && ["queued", "retry", "running"].includes(job.status)) ?? null;
  }
}

test("duplicate cron invocations enqueue one row per deterministic schedule key", async () => {
  const store = new FakeJobStore();
  const now = new Date("2026-08-10T09:00:00.000Z");
  const definitions = dueScheduledJobs(now);
  assert.equal(definitions.length, 6);
  const first = await Promise.all(definitions.map((job) => store.enqueue(job)));
  const duplicate = await Promise.all(definitions.map((job) => store.enqueue(job)));
  assert.equal(first.filter((result) => result.created).length, 6);
  assert.equal(duplicate.filter((result) => result.created).length, 0);
  assert.equal(store.jobs.size, 6);
});

test("native cron configuration and daily enqueue window share the canonical 09:00 UTC contract", async () => {
  const [vercelSource, contractSource] = await Promise.all([
    readFile(new URL("../../../../vercel.json", import.meta.url), "utf8"),
    readFile(new URL("../../../../config/scheduler-contract.json", import.meta.url), "utf8"),
  ]);
  const vercel = JSON.parse(vercelSource) as { crons: Array<{ path: string; schedule: string }> };
  const contract = JSON.parse(contractSource) as { endpoint: string; nativeCron: { schedule: string } };
  assert.equal(NATIVE_CRON_SCHEDULE, "0 9 * * *");
  assert.equal(NATIVE_CRON_UTC_HOUR, 9);
  assert.deepEqual(vercel.crons, [{ path: contract.endpoint, schedule: contract.nativeCron.schedule }]);
  assert.equal(dueScheduledJobs(new Date("2026-08-10T08:00:00.000Z")).length, 2);
  assert.deepEqual(
    dueScheduledJobs(new Date("2026-08-10T09:00:00.000Z")).map((job) => job.jobType),
    [
      "integration_live_refresh",
      "quo_sync",
      "qa_biweekly",
      "vos_backfill",
      "ai_reservation_cleanup",
      "qa_weekly_assignment",
    ],
  );
});

test("concurrent manual refreshes of one job type cannot overlap", async () => {
  const store = new FakeJobStore();
  const now = new Date("2026-08-10T10:00:00.000Z");
  await store.enqueue({ jobType: "integration_live_refresh", idempotencyKey: manualJobKey("integration_live_refresh", 1, now) });
  await store.enqueue({ jobType: "integration_live_refresh", idempotencyKey: manualJobKey("integration_live_refresh", 2, now) });
  const first = await store.claim("worker-a", 60_000, now);
  assert.ok(first);
  assert.equal(await store.claim("worker-b", 60_000, now), null);
  await store.complete(first.id, "worker-a", {});
  assert.ok(await store.claim("worker-b", 60_000, now));
});

test("an expired lease is reclaimed after a worker restart", async () => {
  const store = new FakeJobStore();
  const start = new Date("2026-08-10T10:00:00.000Z");
  await store.enqueue({ jobType: "quo_sync", idempotencyKey: "schedule:quo_sync:restart" });
  assert.equal((await store.claim("dead-worker", 1_000, start))?.attempts, 1);
  assert.equal(await store.claim("new-worker", 1_000, new Date(start.getTime() + 999)), null);
  const reclaimed = await store.claim("new-worker", 1_000, new Date(start.getTime() + 1_001));
  assert.equal(reclaimed?.attempts, 2);
  assert.equal(reclaimed?.leaseOwner, "new-worker");
});

test("partial failure retries idempotently and preserves dashboard totals", async () => {
  const store = new FakeJobStore();
  const enqueued = await store.enqueue({ jobType: "quo_sync", idempotencyKey: "provider:EV_SANITIZED_RETRY", maxAttempts: 3 });
  const calls = new Map<string, { connected: number; missed: number }>();
  let attempts = 0;
  const handler = async () => {
    attempts += 1;
    calls.set("CALL_SANITIZED_RETRY", { connected: 1, missed: 0 });
    if (attempts === 1) throw new Error("partial_provider_failure");
    return { upserted: 1 };
  };
  const first = await runNextBackgroundJob(store, { quo_sync: handler }, {
    workerId: "worker-1",
    now: new Date("2026-08-10T10:00:00.000Z"),
    retryAfterMs: 1,
  });
  assert.equal(first.outcome, "retry");
  const second = await runNextBackgroundJob(store, { quo_sync: handler }, {
    workerId: "worker-2",
    now: new Date("2026-08-10T10:00:00.010Z"),
  });
  assert.equal(second.outcome, "completed");
  assert.equal((await store.get(enqueued.job.id))?.attempts, 2);
  assert.equal(calls.size, 1);
  assert.deepEqual([...calls.values()].reduce((total, call) => ({
    totalCalls: total.totalCalls + 1,
    connectedCalls: total.connectedCalls + call.connected,
    missedCalls: total.missedCalls + call.missed,
  }), { totalCalls: 0, connectedCalls: 0, missedCalls: 0 }), {
    totalCalls: 1,
    connectedCalls: 1,
    missedCalls: 0,
  });
});

test("a timed-out job is aborted and made retryable", async () => {
  const store = new FakeJobStore();
  await store.enqueue({ jobType: "live_transfer_refresh", idempotencyKey: "manual:timeout", maxAttempts: 2 });
  const run = await runNextBackgroundJob(store, {
    live_transfer_refresh: async (_job, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  }, { workerId: "worker-timeout", timeoutMs: 10, retryAfterMs: 1 });
  assert.equal(run.outcome, "retry");
  assert.equal(run.errorCode, "timeout");
  assert.equal([...store.jobs.values()][0]?.status, "retry");
});

test("retry limits expose a terminal sanitized failure", async () => {
  const store = new FakeJobStore();
  await store.enqueue({ jobType: "onboarding_report_refresh", idempotencyKey: "manual:failure", maxAttempts: 1 });
  const run = await runNextBackgroundJob(store, {
    onboarding_report_refresh: async () => { throw new Error("database_failure"); },
  }, { workerId: "worker-failure" });
  assert.equal(run.outcome, "failed");
  assert.equal([...store.jobs.values()][0]?.lastErrorCode, "database_failure");
});

test("cleanup failures cannot expose sensitive upstream text", () => {
  const sensitiveDetail = ["api", "key", "synthetic", "sensitive"].join("_");
  assert.equal(
    sanitizedBackgroundJobErrorCode(
      new Error(`${sensitiveDetail} failure while deleting`),
    ),
    "processing_failed",
  );
});

test("successful jobs persist their sanitized result", async () => {
  const store = new FakeJobStore();
  const { job } = await store.enqueue({ jobType: "qa_weekly_assignment", idempotencyKey: "schedule:qa:success" });
  const run = await runNextBackgroundJob(store, {
    qa_weekly_assignment: async () => ({ created: 2, agents: 1 }),
  }, { workerId: "worker-success" });
  assert.equal(run.outcome, "completed");
  assert.deepEqual((await store.get(job.id))?.result, { created: 2, agents: 1 });
});

test("cron authentication is exact and requires a strong configured secret", () => {
  const secret = ["sanitized", "cron", "secret", "32", "bytes"].join("-");
  assert.equal(validCronAuthorization(`Bearer ${secret}`, secret), true);
  assert.equal(validCronAuthorization(`Bearer ${secret}x`, secret), false);
  assert.equal(validCronAuthorization(undefined, secret), false);
  assert.equal(validCronAuthorization("Bearer short", "short"), false);
});

test("server routes contain no process-local scheduler or post-response job launch", async () => {
  const [quo, quoSync, vos, onboarding, liveTransfers, backgroundJobs, migration, vercel] = await Promise.all([
    readFile(new URL("../routes/quo.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/quoSync.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/vos.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/obReport.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/liveTransfers.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/backgroundJobs.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../../lib/db/drizzle/0009_background_jobs.sql", import.meta.url), "utf8"),
    readFile(new URL("../../../../vercel.json", import.meta.url), "utf8"),
  ]);
  for (const source of [quo, quoSync, vos, onboarding, liveTransfers]) {
    assert.doesNotMatch(source, /setInterval\s*\(/);
    assert.doesNotMatch(source, /void\s+(?:runSync|runReport|runClassifier|refreshCallHistory)\s*\(/);
  }
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "background_jobs"/);
  assert.match(migration, /background_jobs_claim_idx/);
  assert.match(migration, /background_jobs_idempotency_uidx/);
  assert.match(migration, /durable_runtime_state/);
  assert.match(backgroundJobs, /JOBS_PER_CRON_INVOCATION = 1/);
  // The checked-in native cron is a daily recovery/housekeeping sweep. The
  // one-minute and fifteen-minute cadences require an operator-selected plan
  // or external authenticated scheduler, as documented in the contract.
  assert.deepEqual(JSON.parse(vercel).crons, [{ path: "/api/jobs/cron", schedule: "0 9 * * *" }]);
  assert.equal(JSON.parse(vercel).functions["api/[...path].mjs"].maxDuration, 300);
});

test("Vercel static responses receive a restrictive browser header policy", async () => {
  const vercel = JSON.parse(
    await readFile(new URL("../../../../vercel.json", import.meta.url), "utf8"),
  ) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
  const staticHtml = vercel.headers.find((entry) => entry.source === "/");
  assert.ok(staticHtml);
  const headers = new Map(staticHtml.headers.map((header) => [header.key.toLowerCase(), header.value]));
  const csp = headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self';/);
  assert.doesNotMatch(csp, /connect-src[^;]*https:/);
  assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|\*/);
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.match(headers.get("permissions-policy") ?? "", /camera=\(\)/);
  assert.match(headers.get("strict-transport-security") ?? "", /max-age=31536000/);
  assert.equal(
    headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
});
