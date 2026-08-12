import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { postgresBackgroundJobStore } from "../lib/backgroundJobStore.js";
import { backgroundJobHandlers } from "../lib/backgroundJobHandlers.js";
import {
  BACKGROUND_JOB_TYPES,
  runNextBackgroundJob,
  type BackgroundJobStatus,
  type BackgroundJobType,
} from "../lib/durableBackgroundJobs.js";
import { validCronAuthorization } from "../lib/cronAuth.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { dueScheduledJobs } from "../lib/backgroundSchedule.js";
import { recordSchedulerHeartbeat, schedulerHealth } from "../lib/schedulerHealth.js";

const router: IRouter = Router();
const JOBS_PER_CRON_INVOCATION = 1;

export async function enqueueDueScheduledJobs(now = new Date()): Promise<{ created: number; known: number }> {
  const definitions = dueScheduledJobs(now);
  const results = await Promise.all(definitions.map((job) => postgresBackgroundJobStore.enqueue(job)));
  const summary = {
    created: results.filter((result) => result.created).length,
    known: results.filter((result) => !result.created).length,
  };
  await recordSchedulerHeartbeat({
    invokedAt: now.toISOString(),
    scheduled: definitions.length,
    ...summary,
  });
  return summary;
}

function cronAuthorized(req: { get(name: string): string | undefined }): boolean {
  return validCronAuthorization(req.get("authorization"), process.env["CRON_SECRET"]);
}

router.get("/jobs/cron", async (req, res) => {
  if ((process.env["CRON_SECRET"]?.trim().length ?? 0) < 16) {
    return res.status(503).json({ error: "CRON_SECRET is not configured" });
  }
  if (!cronAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });

  try {
    const enqueued = await enqueueDueScheduledJobs();
    const workerId = `cron:${randomUUID()}`;
    const runs = [];
    for (let index = 0; index < JOBS_PER_CRON_INVOCATION; index++) {
      const run = await runNextBackgroundJob(postgresBackgroundJobStore, backgroundJobHandlers, {
        workerId,
        leaseMs: 6 * 60_000,
        timeoutMs: 4 * 60_000,
        retryAfterMs: 60_000,
      });
      runs.push(run.outcome === "idle"
        ? { outcome: run.outcome }
        : { outcome: run.outcome, jobId: run.job.id, jobType: run.job.jobType });
      if (run.outcome === "idle" || run.outcome === "retry" || run.outcome === "failed") break;
    }
    return res.json({ ok: true, enqueued, runs });
  } catch (error) {
    req.log.error(error, "background cron invocation failed");
    return res.status(503).json({ error: "Background scheduler is temporarily unavailable" });
  }
});

router.get("/jobs", requireAuth, requireRole("admin"), async (req, res) => {
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  const jobType = typeof req.query["jobType"] === "string" ? req.query["jobType"] : undefined;
  const limit = req.query["limit"] === undefined ? 50 : Number(req.query["limit"]);
  const statuses: BackgroundJobStatus[] = ["queued", "running", "retry", "completed", "failed"];
  if (status && !statuses.includes(status as BackgroundJobStatus)) {
    return res.status(400).json({ error: "Invalid job status" });
  }
  if (jobType && !(BACKGROUND_JOB_TYPES as readonly string[]).includes(jobType)) {
    return res.status(400).json({ error: "Invalid job type" });
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: "Invalid job limit" });
  }
  const jobs = await postgresBackgroundJobStore.list({
    status: status as BackgroundJobStatus | undefined,
    jobType: jobType as BackgroundJobType | undefined,
    limit,
  });
  return res.json({ jobs });
});

router.get("/jobs/scheduler-health", requireAuth, requireRole("admin"), async (_req, res) => {
  return res.json(await schedulerHealth());
});

router.get("/jobs/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid job id" });
  const job = await postgresBackgroundJobStore.get(id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ job });
});

export default router;
