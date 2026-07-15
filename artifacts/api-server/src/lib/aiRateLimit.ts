import type { Pool, PoolClient, QueryResult } from "pg";
import { pool as workspacePool } from "@workspace/db";

type QueryValues = Array<string | number>;
type QueryClient = Pick<PoolClient, "release"> & {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: QueryValues,
  ): Promise<QueryResult<T>>;
};
type ConnectionPool = Pick<Pool, "connect">;

export class AiRateLimitError extends Error {
  readonly retryAfter: number;
  readonly reason: "concurrent" | "minute" | "day" | "lease";

  constructor(reason: AiRateLimitError["reason"], retryAfter: number) {
    super(`AI request limited: ${reason}`);
    this.name = "AiRateLimitError";
    this.reason = reason;
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}
interface DurableLimitOptions {
  feature: string;
  userId: number;
  perMinute: number;
  perDay: number;
}

interface LimitRow extends Record<string, unknown> {
  minute_count: string | number;
  day_count: string | number;
  minute_retry: string | number | null;
  day_retry: string | number | null;
}

async function unlock(client: QueryClient, feature: string, userId: number): Promise<void> {
  await client.query("SELECT pg_advisory_unlock(hashtext($1), $2)", [feature, userId]).catch(() => undefined);
}

// A session advisory lock enforces one active generation across all Vercel
// instances. The usage row and window counts live in PostgreSQL as well.
export async function withDurableAiLimit<T>(
  options: DurableLimitOptions,
  work: () => Promise<T>,
  connectionPool: ConnectionPool = workspacePool,
): Promise<T> {
  const client = await connectionPool.connect() as QueryClient;
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1), $2) AS acquired",
      [options.feature, options.userId],
    );
    locked = lock.rows[0]?.acquired === true;
    if (!locked) throw new AiRateLimitError("concurrent", 1);

    await client.query("BEGIN");
    try {
      const result = await client.query<LimitRow>(
        `SELECT
          count(*) FILTER (WHERE created_at >= now() - interval '1 minute') AS minute_count,
          count(*) FILTER (WHERE created_at >= now() - interval '1 day') AS day_count,
          ceil(extract(epoch FROM (
            min(created_at) FILTER (WHERE created_at >= now() - interval '1 minute')
            + interval '1 minute' - now()
          ))) AS minute_retry,
          ceil(extract(epoch FROM (
            min(created_at) FILTER (WHERE created_at >= now() - interval '1 day')
            + interval '1 day' - now()
          ))) AS day_retry
        FROM ai_request_usage
        WHERE feature = $1 AND user_id = $2`,
        [options.feature, options.userId],
      );
      const row = result.rows[0];
      const minuteCount = Number(row?.minute_count ?? 0);
      const dayCount = Number(row?.day_count ?? 0);
      if (minuteCount >= options.perMinute) {
        throw new AiRateLimitError("minute", Number(row?.minute_retry ?? 60));
      }
      if (dayCount >= options.perDay) {
        throw new AiRateLimitError("day", Number(row?.day_retry ?? 86_400));
      }
      await client.query(
        "INSERT INTO ai_request_usage (feature, user_id) VALUES ($1, $2)",
        [options.feature, options.userId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    return await work();
  } finally {
    if (locked) await unlock(client, options.feature, options.userId);
    client.release();
  }
}

// Global database lock used by the QA scheduler. Holding the connection keeps
// the lock active until the sequential run completes.
export async function withDatabaseLease<T>(
  leaseName: string,
  work: () => Promise<T>,
  connectionPool: ConnectionPool = workspacePool,
): Promise<T> {
  const client = await connectionPool.connect() as QueryClient;
  let locked = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [leaseName],
    );
    locked = result.rows[0]?.acquired === true;
    if (!locked) throw new AiRateLimitError("lease", 60);
    return await work();
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [leaseName]).catch(() => undefined);
    }
    client.release();
  }
}
