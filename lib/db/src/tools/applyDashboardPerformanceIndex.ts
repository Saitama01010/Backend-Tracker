import pg from "pg";

const { Pool } = pg;

export const DASHBOARD_INDEX_NAME = "phone_calls_dashboard_stats_cover_idx";
export const DASHBOARD_INDEX_DEFINITION = `
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "${DASHBOARD_INDEX_NAME}"
  ON "phone_calls" USING btree ("created_at")
  INCLUDE (
    "agent_name",
    "line_name",
    "line_team",
    "line_id",
    "participant",
    "direction",
    "status",
    "duration_seconds",
    "post_answer_seconds"
  )
  WHERE "status" <> 'in-progress'
`;

const APPLY_ACK = "APPLY_DASHBOARD_PERFORMANCE_INDEX";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertSafety(connectionString: string): void {
  const url = new URL(connectionString);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  if (process.env["ONLINE_INDEX_ACK"] !== APPLY_ACK) {
    throw new Error(`ONLINE_INDEX_ACK must equal ${APPLY_ACK}`);
  }
}

async function main(): Promise<void> {
  const connectionString = requiredEnvironment("DATABASE_URL");
  assertSafety(connectionString);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();
  let advisoryLock = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [DASHBOARD_INDEX_NAME],
    );
    advisoryLock = lock.rows[0]?.acquired === true;
    if (!advisoryLock) throw new Error("another dashboard index operation is already running");

    const existing = await client.query<{
      indisvalid: boolean;
      indisready: boolean;
      definition: string;
    }>(`
      SELECT index.indisvalid, index.indisready, pg_get_indexdef(index.indexrelid) AS definition
      FROM pg_index AS index
      INNER JOIN pg_class AS relation ON relation.oid = index.indexrelid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relname = $1 AND namespace.nspname = current_schema()
    `, [DASHBOARD_INDEX_NAME]);
    if (existing.rows[0] && (!existing.rows[0].indisvalid || !existing.rows[0].indisready)) {
      throw new Error("the existing dashboard index is invalid or not ready; manual recovery is required");
    }
    if (existing.rows[0] && !existing.rows[0].definition.includes("INCLUDE (agent_name, line_name, line_team, line_id, participant, direction, status, duration_seconds, post_answer_seconds)")) {
      throw new Error("the existing dashboard index name has an unexpected definition");
    }

    const blockers = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND xact_start IS NOT NULL
        AND now() - xact_start > interval '5 minutes'
    `);
    if ((blockers.rows[0]?.count ?? 0) > 0) {
      throw new Error("long-running database transactions must finish before online index creation");
    }

    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '20min'");
    const startedAt = Date.now();
    await client.query(DASHBOARD_INDEX_DEFINITION);

    const verified = await client.query<{
      indisvalid: boolean;
      indisready: boolean;
      bytes: string;
    }>(`
      SELECT
        index.indisvalid,
        index.indisready,
        pg_relation_size(index.indexrelid)::bigint::text AS bytes
      FROM pg_index AS index
      INNER JOIN pg_class AS relation ON relation.oid = index.indexrelid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relname = $1 AND namespace.nspname = current_schema()
    `, [DASHBOARD_INDEX_NAME]);
    const row = verified.rows[0];
    if (!row?.indisvalid || !row.indisready) throw new Error("dashboard index verification failed");
    console.log(JSON.stringify({
      index: DASHBOARD_INDEX_NAME,
      valid: row.indisvalid,
      ready: row.indisready,
      bytes: Number(row.bytes),
      durationMs: Date.now() - startedAt,
    }));
  } finally {
    if (advisoryLock) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [DASHBOARD_INDEX_NAME]).catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

await main();
