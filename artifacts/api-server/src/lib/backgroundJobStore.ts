import type { QueryResultRow } from "pg";
import { pool } from "@workspace/db";
import {
  BACKGROUND_JOB_TYPES,
  type BackgroundJobType,
  type DurableBackgroundJob,
  type DurableBackgroundJobStore,
  type EnqueueBackgroundJob,
  type EnqueueResult,
} from "./durableBackgroundJobs.js";

interface JobRow extends QueryResultRow {
  id: number;
  job_type: string;
  idempotency_key: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  requested_by_user_id: number | null;
  run_after: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
  created?: boolean;
}

function jobType(value: string): BackgroundJobType {
  if (!(BACKGROUND_JOB_TYPES as readonly string[]).includes(value)) throw new Error("unknown_job_type");
  return value as BackgroundJobType;
}

function mapJob(row: JobRow): DurableBackgroundJob {
  return {
    id: Number(row.id),
    jobType: jobType(row.job_type),
    idempotencyKey: row.idempotency_key,
    status: row.status as DurableBackgroundJob["status"],
    payload: row.payload ?? {},
    result: row.result ?? null,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    requestedByUserId: row.requested_by_user_id === null ? null : Number(row.requested_by_user_id),
    runAfter: new Date(row.run_after),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
    lastErrorCode: row.last_error_code,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    updatedAt: new Date(row.updated_at),
  };
}

const RETURNING_COLUMNS = `
  id, job_type, idempotency_key, status, payload, result, priority,
  attempts, max_attempts, requested_by_user_id, run_after, lease_owner,
  lease_expires_at, last_error_code, created_at, started_at, finished_at, updated_at`;

const CLAIM_RETURNING_COLUMNS = `
  jobs.id, jobs.job_type, jobs.idempotency_key, jobs.status, jobs.payload, jobs.result, jobs.priority,
  jobs.attempts, jobs.max_attempts, jobs.requested_by_user_id, jobs.run_after, jobs.lease_owner,
  jobs.lease_expires_at, jobs.last_error_code, jobs.created_at, jobs.started_at, jobs.finished_at, jobs.updated_at`;

export const postgresBackgroundJobStore: DurableBackgroundJobStore = {
  async enqueue(input: EnqueueBackgroundJob): Promise<EnqueueResult> {
    const result = await pool.query<JobRow>(`
      INSERT INTO background_jobs (
        job_type, idempotency_key, payload, priority, max_attempts,
        requested_by_user_id, run_after
      ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
      ON CONFLICT (idempotency_key) DO UPDATE
        SET updated_at = background_jobs.updated_at
      RETURNING ${RETURNING_COLUMNS}, (xmax = 0) AS created
    `, [
      input.jobType,
      input.idempotencyKey,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      input.maxAttempts ?? 3,
      input.requestedByUserId ?? null,
      input.runAfter ?? new Date(),
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("job_enqueue_failed");
    return { job: mapJob(row), created: row.created === true };
  },

  async claim(workerId: string, leaseMs: number, now = new Date(), jobId?: number): Promise<DurableBackgroundJob | null> {
    await pool.query(`
      UPDATE background_jobs
      SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = COALESCE(last_error_code, 'lease_expired'),
          finished_at = $1, updated_at = $1
      WHERE status = 'running' AND lease_expires_at <= $1 AND attempts >= max_attempts
    `, [now]);
    const result = await pool.query<JobRow>(`
      WITH candidate AS (
        SELECT pending.id
        FROM background_jobs AS pending
        WHERE pending.attempts < pending.max_attempts
          AND ($4::integer IS NULL OR pending.id = $4)
          AND (
            (pending.status IN ('queued', 'retry') AND pending.run_after <= $1)
            OR (pending.status = 'running' AND pending.lease_expires_at <= $1)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM background_jobs AS active
            WHERE active.job_type = pending.job_type
              AND active.id <> pending.id
              AND active.status = 'running'
              AND active.lease_expires_at > $1
          )
          AND pg_try_advisory_xact_lock(hashtext('background_job:' || pending.job_type))
        ORDER BY pending.priority DESC, pending.run_after ASC, pending.id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE background_jobs AS jobs
      SET status = 'running',
          attempts = jobs.attempts + 1,
          lease_owner = $2,
          lease_expires_at = $1 + ($3 * interval '1 millisecond'),
          last_error_code = NULL,
          started_at = COALESCE(jobs.started_at, $1),
          finished_at = NULL,
          updated_at = $1
      FROM candidate
      WHERE jobs.id = candidate.id
      RETURNING ${CLAIM_RETURNING_COLUMNS}
    `, [now, workerId, leaseMs, jobId ?? null]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  },

  async complete(jobId: number, workerId: string, resultValue: Record<string, unknown>): Promise<boolean> {
    const result = await pool.query(`
      UPDATE background_jobs
      SET status = 'completed', result = $3::jsonb, lease_owner = NULL,
          lease_expires_at = NULL, last_error_code = NULL,
          finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING id
    `, [jobId, workerId, JSON.stringify(resultValue)]);
    return result.rowCount === 1;
  },

  async fail(jobId: number, workerId: string, errorCode: string, retryAfterMs: number): Promise<boolean> {
    const result = await pool.query(`
      UPDATE background_jobs
      SET status = CASE WHEN attempts < max_attempts THEN 'retry' ELSE 'failed' END,
          run_after = CASE WHEN attempts < max_attempts
            THEN now() + ($4 * interval '1 millisecond') ELSE run_after END,
          lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = $3,
          finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
          updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
      RETURNING id
    `, [jobId, workerId, errorCode, retryAfterMs]);
    return result.rowCount === 1;
  },

  async get(jobId: number): Promise<DurableBackgroundJob | null> {
    const result = await pool.query<JobRow>(`
      SELECT ${RETURNING_COLUMNS} FROM background_jobs WHERE id = $1 LIMIT 1
    `, [jobId]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  },

  async list(options = {}): Promise<DurableBackgroundJob[]> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const result = await pool.query<JobRow>(`
      SELECT ${RETURNING_COLUMNS}
      FROM background_jobs
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR job_type = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT $3
    `, [options.status ?? null, options.jobType ?? null, limit]);
    return result.rows.map(mapJob);
  },

  async findActive(type: BackgroundJobType): Promise<DurableBackgroundJob | null> {
    const result = await pool.query<JobRow>(`
      SELECT ${RETURNING_COLUMNS}
      FROM background_jobs
      WHERE job_type = $1 AND status IN ('queued', 'retry', 'running')
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `, [type]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  },
};
