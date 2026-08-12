import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import { pool as workspacePool } from "@workspace/db";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface AiReservationCleanupConfig {
  retentionDays: number;
  batchSize: number;
  maxBatches: number;
}

export interface AiReservationCleanupResult {
  readonly [key: string]: unknown;
  rowsExamined: number;
  rowsDeleted: number;
  batches: number;
  oldestRetainedExpiration: string | null;
  durationMs: number;
}

interface CleanupRow extends Record<string, unknown> {
  deleted_count: string | number;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

export function aiReservationCleanupConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AiReservationCleanupConfig {
  return {
    retentionDays: boundedInteger(
      environment["AI_RESERVATION_RETENTION_DAYS"],
      30,
      1,
      365,
      "AI_RESERVATION_RETENTION_DAYS",
    ),
    batchSize: boundedInteger(
      environment["AI_RESERVATION_CLEANUP_BATCH_SIZE"],
      500,
      10,
      5_000,
      "AI_RESERVATION_CLEANUP_BATCH_SIZE",
    ),
    maxBatches: boundedInteger(
      environment["AI_RESERVATION_CLEANUP_MAX_BATCHES"],
      4,
      1,
      20,
      "AI_RESERVATION_CLEANUP_MAX_BATCHES",
    ),
  };
}

export async function cleanupExpiredAiReservations(
  config = aiReservationCleanupConfig(),
  connectionPool: Pick<Pool, "query"> = workspacePool,
  now = new Date(),
): Promise<AiReservationCleanupResult> {
  const started = performance.now();
  const cutoff = new Date(now.getTime() - config.retentionDays * DAY_MS);
  let rowsExamined = 0;
  let rowsDeleted = 0;
  let batches = 0;

  for (; batches < config.maxBatches; batches += 1) {
    const result = await connectionPool.query<CleanupRow>(
      `WITH candidates AS (
         SELECT id
           FROM ai_request_reservations
          WHERE expires_at < $1
          ORDER BY expires_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM ai_request_reservations AS reservations
          USING candidates
          WHERE reservations.id = candidates.id
          RETURNING reservations.id
       )
       SELECT (SELECT count(*) FROM candidates) AS deleted_count`,
      [cutoff, config.batchSize],
    );
    const deleted = Number(result.rows[0]?.deleted_count ?? 0);
    rowsExamined += deleted;
    rowsDeleted += deleted;
    if (deleted < config.batchSize) {
      batches += 1;
      break;
    }
  }

  const oldest = await connectionPool.query<{ expires_at: Date }>(
    `SELECT expires_at
       FROM ai_request_reservations
      ORDER BY expires_at, id
      LIMIT 1`,
  );
  const oldestRetained = oldest.rows[0]?.expires_at;
  return {
    rowsExamined,
    rowsDeleted,
    batches,
    oldestRetainedExpiration: oldestRetained
      ? new Date(oldestRetained).toISOString()
      : null,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  };
}
