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
  timedOut: boolean;
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
    p99Ms: percentile(values, 0.99),
    maxMs: Math.max(...values),
    payloadBytesP50: percentile(samples.map((sample) => sample.bytes), 0.5),
    errors: samples.filter((sample) => sample.status >= 400).length,
    timeouts: samples.filter((sample) => sample.timedOut).length,
    cacheHits: samples.filter((sample) => sample.cache === "hit").length,
  };
}

test("sanitized dashboard reads record 10, 25, and 50-client concurrency baselines without exhaustion", async (t) => {
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
      try {
        const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5_000) });
        const body = await response.arrayBuffer();
        return {
          ms: Math.round((performance.now() - startedAt) * 100) / 100,
          bytes: body.byteLength,
          status: response.status,
          timedOut: false,
          cache: response.headers.get("x-cache"),
          serverTiming: response.headers.get("server-timing"),
        };
      } catch (error) {
        return {
          ms: Math.round((performance.now() - startedAt) * 100) / 100,
          bytes: 0,
          status: 0,
          timedOut: error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`),
          cache: null,
          serverTiming: null,
        };
      }
    };
    const statsPath = "/api/quo/stats?from=2026-02-01T00%3A00%3A00.000Z&to=2026-02-28T23%3A59%3A59.999Z";
    for (let warmup = 0; warmup < 5; warmup++) await request(statsPath);
    for (let warmup = 0; warmup < 5; warmup++) await request("/api/quo/live");

    const runConcurrent = async (path: (index: number) => string, count: number, concurrency: number) => {
      const samples: Sample[] = [];
      for (let offset = 0; offset < count; offset += concurrency) {
        samples.push(...await Promise.all(
          Array.from({ length: Math.min(concurrency, count - offset) }, (_, index) => request(path(offset + index))),
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
    const concurrencyResults = [];
    const serverTimingExamples: { stats: string | null; live: string | null } = { stats: null, live: null };
    for (const concurrency of [10, 25, 50]) {
      const poolSamples: Array<{ total: number; idle: number; waiting: number }> = [];
      const sampler = setInterval(() => poolSamples.push({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }), 5);
      const memoryBefore = process.memoryUsage();
      const cpuBefore = process.cpuUsage();
      const statsSamples = await runConcurrent(
        (index) => `${statsPath}&phase1LoadRequest=${concurrency}-${index}`,
        100,
        concurrency,
      );
      const liveSamples = await runConcurrent(
        (index) => `/api/quo/live?phase1LoadRequest=${concurrency}-${index}`,
        100,
        concurrency,
      );
      serverTimingExamples.stats ??= statsSamples[0]?.serverTiming ?? null;
      serverTimingExamples.live ??= liveSamples[0]?.serverTiming ?? null;
      clearInterval(sampler);
      poolSamples.push({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
      const cpu = process.cpuUsage(cpuBefore);
      const memoryAfter = process.memoryUsage();
      const stats = summarize(statsSamples);
      const live = summarize(liveSamples);
      assert.equal(stats.errors, 0);
      assert.equal(live.errors, 0);
      assert.equal(stats.timeouts, 0);
      assert.equal(live.timeouts, 0);
      assert.ok(stats.p95Ms < 5_000);
      assert.ok(live.p95Ms < 5_000);
      const poolPeak = {
        total: Math.max(...poolSamples.map((sample) => sample.total)),
        active: Math.max(...poolSamples.map((sample) => sample.total - sample.idle)),
        waiting: Math.max(...poolSamples.map((sample) => sample.waiting)),
      };
      concurrencyResults.push({
        concurrentClients: concurrency,
        requestCount: stats.n + live.n,
        errorCount: stats.errors + live.errors,
        timeouts: stats.timeouts + live.timeouts,
        connectionExhaustion: stats.errors + live.errors + stats.timeouts + live.timeouts > 0,
        stats,
        live,
        databasePool: { peak: poolPeak, waitSampleCount: poolSamples.filter((sample) => sample.waiting > 0).length },
        memory: {
          rssBeforeBytes: memoryBefore.rss,
          rssAfterBytes: memoryAfter.rss,
          rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
          heapUsedBeforeBytes: memoryBefore.heapUsed,
          heapUsedAfterBytes: memoryAfter.heapUsed,
          heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
        },
        cpu: { userMs: Math.round(cpu.user / 1_000), systemMs: Math.round(cpu.system / 1_000) },
      });
    }
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
    console.log(`READ_LOAD_EVIDENCE ${JSON.stringify({
      dataset: { phoneCalls: 220_000, agents: 120, source: "sanitized generated local PostgreSQL rows" },
      concurrencyResults,
      database: { before: databaseBefore.rows[0], after: databaseAfter.rows[0] },
      serverTimingExamples,
    })}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
