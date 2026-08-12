import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import test from "node:test";

function localLoadDatabaseUrl(): string | null {
  const raw = process.env["PERFORMANCE_LOAD_DATABASE_URL"]?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  const safeName = /(?:test|performance)/i.test(url.pathname);
  if (!local || !safeName) {
    throw new Error("PERFORMANCE_LOAD_DATABASE_URL must be a local disposable test database");
  }
  return raw;
}

type Sample = {
  ms: number;
  bytes: number;
  status: number;
  cache: string | null;
  serverTiming: string | null;
};

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]!;
}

function summarize(samples: Sample[]) {
  const values = samples.map((sample) => sample.ms);
  return {
    n: samples.length,
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
    payloadBytesP50: percentile(samples.map((sample) => sample.bytes), 0.5),
    errors: samples.filter((sample) => sample.status >= 400).length,
    cacheHits: samples.filter((sample) => sample.cache === "hit").length,
  };
}

test("optimized dashboard read endpoints remain bounded at 20 concurrent clients", async (t) => {
  const connectionString = localLoadDatabaseUrl();
  if (!connectionString) {
    t.skip("PERFORMANCE_LOAD_DATABASE_URL is not configured");
    return;
  }
  process.env["DATABASE_URL"] = connectionString;
  process.env["NODE_ENV"] = "test";
  process.env["SESSION_SECRET"] = "sanitized-load-test-session-secret";
  process.env["ENABLE_BACKGROUND_JOBS"] = "false";

  const [{ default: app }, { pool }, { signToken }] = await Promise.all([
    import("../app.js"),
    import("@workspace/db"),
    import("../middleware/auth.js"),
  ]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sessionId = randomUUID();

  try {
    await pool.query(`
      TRUNCATE TABLE phone_calls, blocked_numbers, phone_sync_state,
        durable_runtime_state, auth_sessions, portal_users RESTART IDENTITY CASCADE
    `);
    await pool.query(`
      INSERT INTO phone_calls(
        id, agent_name, agent_id, line_id, line_team, participant, direction,
        status, line_name, duration_seconds, post_answer_seconds, created_at, synced_at
      )
      SELECT
        'load-call-' || value,
        'Synthetic Agent ' || (value % 120),
        'synthetic-agent-' || (value % 120),
        'synthetic-line-' || (value % 8),
        CASE WHEN value % 3 = 0 THEN 'cs' WHEN value % 3 = 1 THEN 'retention' ELSE 'nsf' END,
        'synthetic-contact-' || (value % 5000),
        CASE WHEN value % 4 = 0 THEN 'incoming' ELSE 'outgoing' END,
        CASE WHEN value % 113 = 0 THEN 'in-progress' WHEN value % 28 = 0 THEN 'missed' ELSE 'completed' END,
        'Synthetic Line ' || (value % 8),
        value % 900,
        CASE WHEN value % 4 = 0 THEN NULL ELSE value % 300 END,
        timestamptz '2026-01-01T00:00:00Z' + (value % 129600) * interval '1 minute',
        CASE WHEN value % 113 = 0 THEN now() ELSE timestamptz '2026-04-01T00:00:00Z' END
      FROM generate_series(1, 220000) AS value
    `);
    await pool.query("VACUUM (ANALYZE) phone_calls");
    const user = await pool.query<{ id: number }>(`
      INSERT INTO portal_users(username, password_hash, role, permissions, active)
      VALUES ('sanitized-load-admin', 'unused', 'admin', '["view_metrics"]', true)
      RETURNING id
    `);
    const userId = user.rows[0]!.id;
    await pool.query(`
      INSERT INTO auth_sessions(id, user_id, refresh_token_hash, expires_at)
      VALUES ($1, $2, 'sanitized-load-refresh-hash', now() + interval '1 day')
    `, [sessionId, userId]);
    const token = signToken({
      userId,
      username: "sanitized-load-admin",
      role: "admin",
      permissions: ["view_metrics"],
      sessionId,
    });
    const headers = { Authorization: `Bearer ${token}` };
    const request = async (path: string): Promise<Sample> => {
      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}${path}`, { headers });
      const body = await response.arrayBuffer();
      return {
        ms: Math.round((performance.now() - startedAt) * 100) / 100,
        bytes: body.byteLength,
        status: response.status,
        cache: response.headers.get("x-cache"),
        serverTiming: response.headers.get("server-timing"),
      };
    };
    const statsPath = "/api/quo/stats?from=2026-02-01T00%3A00%3A00.000Z&to=2026-02-28T23%3A59%3A59.999Z";
    for (let warmup = 0; warmup < 5; warmup++) await request(statsPath);
    for (let warmup = 0; warmup < 5; warmup++) await request("/api/quo/live");

    const runConcurrent = async (path: string, count: number, concurrency: number) => {
      const samples: Sample[] = [];
      for (let offset = 0; offset < count; offset += concurrency) {
        samples.push(...await Promise.all(
          Array.from({ length: Math.min(concurrency, count - offset) }, () => request(path)),
        ));
      }
      return samples;
    };
    const databaseBefore = await pool.query<{
      sessions: string;
      active_time_ms: string;
      transactions: string;
    }>(`
      SELECT numbackends::text AS sessions,
             round(active_time::numeric, 2)::text AS active_time_ms,
             (xact_commit + xact_rollback)::text AS transactions
      FROM pg_stat_database WHERE datname = current_database()
    `);
    const statsSamples = await runConcurrent(statsPath, 60, 20);
    const liveSamples = await runConcurrent("/api/quo/live", 60, 20);
    const databaseAfter = await pool.query<{
      sessions: string;
      active_time_ms: string;
      transactions: string;
    }>(`
      SELECT numbackends::text AS sessions,
             round(active_time::numeric, 2)::text AS active_time_ms,
             (xact_commit + xact_rollback)::text AS transactions
      FROM pg_stat_database WHERE datname = current_database()
    `);
    const stats = summarize(statsSamples);
    const live = summarize(liveSamples);
    assert.equal(stats.errors, 0);
    assert.equal(live.errors, 0);
    assert.ok(stats.cacheHits >= 57, "at least 95% of measured repeated summary reads must hit the scoped cache");
    assert.ok(stats.p95Ms < 1_000);
    assert.ok(live.p95Ms < 500);
    console.log(`READ_LOAD_EVIDENCE ${JSON.stringify({
      dataset: { phoneCalls: 220_000, agents: 120, concurrentClients: 20 },
      stats,
      live,
      database: { before: databaseBefore.rows[0], after: databaseAfter.rows[0] },
      serverTimingExamples: {
        stats: statsSamples[0]?.serverTiming ?? null,
        live: liveSamples[0]?.serverTiming ?? null,
      },
    })}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
