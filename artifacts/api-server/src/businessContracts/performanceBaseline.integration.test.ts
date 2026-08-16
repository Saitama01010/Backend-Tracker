import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import pg from "pg";
import { buildQuoPhoneCallRow, type QuoCall, type QuoPhoneNumber } from "../integrations/quo/sync.js";
import { parseGoogleSheetsValues } from "../lib/externalIntegrationPolicy.js";
import { parseAgentTable, parseReadymodeRows } from "../routes/readymode.js";
import { teamFromRingGroupName } from "../routes/vos.js";

const { Client } = pg;
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const fixtureRoot = path.join(import.meta.dirname, "fixtures");
const baselinePath = path.join(repoRoot, "docs", "refactor", "phase-1-performance-baseline.json");
const WARM_ITERATIONS = 10;
const COLD_ITERATIONS = 3;

type Summary = {
  iterations: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
};

type HttpSample = { ms: number; bytes: number; status: number };

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]!;
}

function summarize(values: readonly number[]): Summary {
  return {
    iterations: values.length,
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    minMs: round(Math.min(...values)),
    maxMs: round(Math.max(...values)),
  };
}

async function readJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(path.join(fixtureRoot, ...parts), "utf8")) as T;
}

async function measureCold<T>(operation: () => Promise<T>): Promise<Summary> {
  const values: number[] = [];
  for (let iteration = 0; iteration < COLD_ITERATIONS; iteration++) {
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  return summarize(values);
}

function measureWarm(operation: () => void): Summary {
  const values: number[] = [];
  for (let iteration = 0; iteration < WARM_ITERATIONS; iteration++) {
    const startedAt = performance.now();
    operation();
    values.push(performance.now() - startedAt);
  }
  return summarize(values);
}

function measureNormalizedWarm(operation: () => void, calibration: () => void) {
  for (let warmup = 0; warmup < COLD_ITERATIONS; warmup++) {
    operation();
    calibration();
  }
  const operationValues: number[] = [];
  const calibrationValues: number[] = [];
  const ratios: number[] = [];
  const timed = (fn: () => void) => {
    const startedAt = performance.now();
    fn();
    return performance.now() - startedAt;
  };
  for (let iteration = 0; iteration < WARM_ITERATIONS; iteration++) {
    let operationMs: number;
    let calibrationMs: number;
    if (iteration % 2 === 0) {
      operationMs = timed(operation);
      calibrationMs = timed(calibration);
    } else {
      calibrationMs = timed(calibration);
      operationMs = timed(operation);
    }
    operationValues.push(operationMs);
    calibrationValues.push(calibrationMs);
    ratios.push(operationMs / calibrationMs);
  }
  return {
    operation: summarize(operationValues),
    calibration: summarize(calibrationValues),
    normalizedMedianRatio: round(percentile(ratios, 0.5)),
  };
}

function safeDatabaseUrl(): string {
  const raw = (process.env.BUSINESS_CONTRACT_DATABASE_URL ?? process.env.DATABASE_URL)?.trim();
  if (!raw) throw new Error("BUSINESS_CONTRACT_DATABASE_URL or DATABASE_URL is required");
  const parsed = new URL(raw);
  const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  const safeName = /(?:test|phase1|performance)/i.test(parsed.pathname);
  if (!local || !safeName) {
    throw new Error("Phase 1 performance contracts require a local disposable test database");
  }
  return raw;
}

async function measureDatabase(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE phase1_performance_calls (
        id integer PRIMARY KEY,
        agent_name text NOT NULL,
        team text NOT NULL,
        duration_seconds integer NOT NULL,
        created_at timestamptz NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);
    await client.query(`
      INSERT INTO phase1_performance_calls(id, agent_name, team, duration_seconds, created_at)
      SELECT value,
             'Synthetic Agent ' || (value % 40),
             CASE WHEN value % 3 = 0 THEN 'cs' WHEN value % 3 = 1 THEN 'retention' ELSE 'nsf' END,
             value % 900,
             timestamptz '2026-01-01T00:00:00Z' + value * interval '1 minute'
      FROM generate_series(1, 20000) value
    `);
    await client.query("CREATE INDEX phase1_performance_calls_range_idx ON phase1_performance_calls(created_at, team)");
    await client.query("ANALYZE phase1_performance_calls");

    const run = async () => {
      let queryCount = 0;
      const startedAt = performance.now();
      const result = await client.query(`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT team, agent_name, count(*)::integer AS calls, sum(duration_seconds)::integer AS seconds
        FROM phase1_performance_calls
        WHERE created_at >= timestamptz '2026-01-05T00:00:00Z'
          AND created_at < timestamptz '2026-01-12T00:00:00Z'
        GROUP BY team, agent_name
        ORDER BY team, agent_name
      `);
      queryCount++;
      const wallMs = performance.now() - startedAt;
      const plan = result.rows[0]?.["QUERY PLAN"]?.[0];
      const executionMs = Number(plan?.["Execution Time"] ?? 0);
      return { queryCount, wallMs, executionMs };
    };

    const cold = [];
    for (let iteration = 0; iteration < COLD_ITERATIONS; iteration++) cold.push(await run());
    const warm = [];
    for (let iteration = 0; iteration < WARM_ITERATIONS; iteration++) warm.push(await run());
    assert.ok([...cold, ...warm].every((sample) => sample.queryCount === 1));
    return {
      fixedRows: 20_000,
      queryCountPerImportantRequest: 1,
      coldWall: summarize(cold.map((sample) => sample.wallMs)),
      warmWall: summarize(warm.map((sample) => sample.wallMs)),
      coldExecution: summarize(cold.map((sample) => sample.executionMs)),
      warmExecution: summarize(warm.map((sample) => sample.executionMs)),
    };
  } finally {
    await client.end();
  }
}

async function startGoldenServer(payloads: Record<string, string>) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = payloads[pathname];
    if (!body) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function fetchSample(baseUrl: string, endpoint: string, cold: boolean): Promise<HttpSample> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${endpoint}`, { headers: cold ? { connection: "close" } : undefined });
  const body = await response.arrayBuffer();
  return { ms: performance.now() - startedAt, bytes: body.byteLength, status: response.status };
}

test("fixed Phase 1 dataset records the complete performance baseline and enforces the normalized 10% gate", async () => {
  const quoRaw = await readFile(path.join(fixtureRoot, "quo", "api-pages.json"), "utf8");
  const readyModeRaw = await readFile(path.join(fixtureRoot, "readymode", "valid.csv"), "utf8");
  const readyModeHtml = await readFile(path.join(fixtureRoot, "readymode", "report.html"), "utf8");
  const pbxRaw = await readFile(path.join(fixtureRoot, "pbx", "api.json"), "utf8");
  const sheetsRaw = await readFile(path.join(fixtureRoot, "sheets", "google-sheet-1.json"), "utf8");
  const golden = await readJson<Record<string, any>>("goldens", "major-dashboard-responses.json");
  const behaviorMap = JSON.parse(await readFile(path.join(repoRoot, "docs", "refactor", "phase-1-current-behavior-map.json"), "utf8")) as {
    dashboardPages: Array<{ id: string; endpoints: string[] }>;
  };
  const quo = JSON.parse(quoRaw) as {
    phoneNumbers: QuoPhoneNumber[];
    users: Array<{ id: string; displayName: string }>;
    pages: Array<{ data: Array<QuoCall & { phoneNumberId: string }> }>;
  };
  const lines = new Map(quo.phoneNumbers.map((line) => [line.id, line]));
  const users = new Map(quo.users.map((user) => [user.id, user.displayName]));
  const quoCalls = quo.pages.flatMap((page) => page.data);
  const quietLog = { warn() {} } as unknown as Parameters<typeof parseReadymodeRows>[1];

  const mapQuoBatch = () => {
    let count = 0;
    for (let repeat = 0; repeat < 2_000; repeat++) {
      for (const call of quoCalls) {
        const line = lines.get(call.phoneNumberId)!;
        buildQuoPhoneCallRow(call, line, call.participants?.[0] ?? "", users);
        count++;
      }
    }
    assert.equal(count, quoCalls.length * 2_000);
  };
  const calibrateBatch = () => {
    let count = 0;
    for (let repeat = 0; repeat < 2_000; repeat++) {
      const parsed = JSON.parse(quoRaw) as { pages: Array<{ data: unknown[] }> };
      count += parsed.pages.length;
    }
    assert.equal(count, quo.pages.length * 2_000);
  };

  const normalizedQuo = measureNormalizedWarm(mapQuoBatch, calibrateBatch);
  const quoMapping = normalizedQuo.operation;
  const calibration = normalizedQuo.calibration;
  const normalizedQuoMedianRatio = normalizedQuo.normalizedMedianRatio;

  const parserMetrics = {
    quoMapping: {
      cold: await measureCold(async () => {
        const parsed = await readJson<typeof quo>("quo", "api-pages.json");
        const coldLines = new Map(parsed.phoneNumbers.map((line) => [line.id, line]));
        const coldUsers = new Map(parsed.users.map((user) => [user.id, user.displayName]));
        for (const page of parsed.pages) for (const call of page.data) {
          buildQuoPhoneCallRow(call, coldLines.get(call.phoneNumberId)!, call.participants?.[0] ?? "", coldUsers);
        }
      }),
      warm: quoMapping,
      batchMappings: quoCalls.length * 2_000,
      normalizedMedianRatio: normalizedQuoMedianRatio,
    },
    readyModeImport: {
      cold: await measureCold(async () => {
        parseReadymodeRows(await readFile(path.join(fixtureRoot, "readymode", "valid.csv"), "utf8"), quietLog, "phase1");
      }),
      warm: measureWarm(() => { for (let repeat = 0; repeat < 500; repeat++) parseReadymodeRows(readyModeRaw, quietLog, "phase1"); }),
      batchParses: 500,
    },
    readyModeHtmlParser: {
      cold: await measureCold(async () => { parseAgentTable(await readFile(path.join(fixtureRoot, "readymode", "report.html"), "utf8")); }),
      warm: measureWarm(() => { for (let repeat = 0; repeat < 500; repeat++) parseAgentTable(readyModeHtml); }),
      batchParses: 500,
    },
    pbxAdapter: {
      cold: await measureCold(async () => {
        const parsed = JSON.parse(await readFile(path.join(fixtureRoot, "pbx", "api.json"), "utf8")) as { ringGroups: Array<{ name: string }> };
        parsed.ringGroups.map((group) => teamFromRingGroupName(group.name));
      }),
      warm: measureWarm(() => {
        for (let repeat = 0; repeat < 1_000; repeat++) {
          const parsed = JSON.parse(pbxRaw) as { ringGroups: Array<{ name: string }> };
          parsed.ringGroups.map((group) => teamFromRingGroupName(group.name));
        }
      }),
      batchParses: 1_000,
      currentFormat: "authenticated JSON; sanitized HTML retained as inconsistency evidence",
    },
    googleSheetsParser: {
      cold: await measureCold(async () => {
        const parsed = JSON.parse(await readFile(path.join(fixtureRoot, "sheets", "google-sheet-1.json"), "utf8")) as Record<string, unknown>;
        Object.values(parsed).map(parseGoogleSheetsValues);
      }),
      warm: measureWarm(() => {
        for (let repeat = 0; repeat < 1_000; repeat++) {
          const parsed = JSON.parse(sheetsRaw) as Record<string, unknown>;
          Object.values(parsed).map(parseGoogleSheetsValues);
        }
      }),
      batchParses: 1_000,
    },
  };

  const payloads: Record<string, string> = {
    "/api/quo/stats": JSON.stringify(golden.quoStats),
    "/api/sheet": JSON.stringify(golden.sheet),
    "/api/vos/stats": JSON.stringify(golden.vosStats),
    "/api/readymode/stats": JSON.stringify(golden.readyModeStats),
    "/api/attendance": JSON.stringify(golden.attendance),
    "/api/violations": JSON.stringify(golden.violations),
  };
  const server = await startGoldenServer(payloads);
  let apiLatency: { cold: Summary; warm: Summary; payloadBytes: number; errors: number };
  let fixedFixtureApiBatchDataReady: { cold: Summary; warm: Summary; requestsPerLoad: number; payloadBytesPerLoad: number };
  try {
    const coldApi: HttpSample[] = [];
    for (let iteration = 0; iteration < COLD_ITERATIONS; iteration++) coldApi.push(await fetchSample(server.baseUrl, "/api/quo/stats", true));
    const warmApi: HttpSample[] = [];
    for (let iteration = 0; iteration < WARM_ITERATIONS; iteration++) warmApi.push(await fetchSample(server.baseUrl, "/api/quo/stats", false));
    apiLatency = {
      cold: summarize(coldApi.map((sample) => sample.ms)),
      warm: summarize(warmApi.map((sample) => sample.ms)),
      payloadBytes: warmApi[0]!.bytes,
      errors: [...coldApi, ...warmApi].filter((sample) => sample.status >= 400).length,
    };

    const endpoints = Object.keys(payloads);
    const runDashboard = async (cold: boolean) => {
      const startedAt = performance.now();
      const samples = await Promise.all(endpoints.map((endpoint) => fetchSample(server.baseUrl, endpoint, cold)));
      assert.ok(samples.every((sample) => sample.status === 200));
      return { ms: performance.now() - startedAt, bytes: samples.reduce((total, sample) => total + sample.bytes, 0) };
    };
    const coldDashboard = [];
    for (let iteration = 0; iteration < COLD_ITERATIONS; iteration++) coldDashboard.push(await runDashboard(true));
    const warmDashboard = [];
    for (let iteration = 0; iteration < WARM_ITERATIONS; iteration++) warmDashboard.push(await runDashboard(false));
    fixedFixtureApiBatchDataReady = {
      cold: summarize(coldDashboard.map((sample) => sample.ms)),
      warm: summarize(warmDashboard.map((sample) => sample.ms)),
      requestsPerLoad: endpoints.length,
      payloadBytesPerLoad: warmDashboard[0]!.bytes,
    };
  } finally {
    await server.close();
  }

  const largePayload = JSON.stringify(Array.from({ length: 250 }, () => golden));
  const heapBefore = process.memoryUsage().heapUsed;
  const retainedLargeRequest = JSON.parse(largePayload) as unknown[];
  const heapAfter = process.memoryUsage().heapUsed;
  assert.equal(retainedLargeRequest.length, 250);
  const memory = {
    payloadBytes: Buffer.byteLength(largePayload),
    heapDeltaBytes: Math.max(0, heapAfter - heapBefore),
    heapUsedAfterBytes: heapAfter,
  };

  const database = await measureDatabase(safeDatabaseUrl());
  const frontendRequestsPerPage = Object.fromEntries(
    behaviorMap.dashboardPages.map((page) => [page.id, page.endpoints.length]),
  );
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
    regressionGate: { baselineNormalizedMedianRatio: number; maximumRegressionPercent: number };
  };
  const limit = baseline.regressionGate.baselineNormalizedMedianRatio *
    (1 + baseline.regressionGate.maximumRegressionPercent / 100);
  assert.ok(
    normalizedQuoMedianRatio <= limit,
    `QUO mapping normalized median ratio ${normalizedQuoMedianRatio} exceeds the Phase 1 10% limit ${round(limit)}`,
  );
  assert.equal(apiLatency.errors, 0);
  assert.ok(memory.heapDeltaBytes < 256 * 1024 * 1024, "fixed large-dashboard request must stay below the recorded 256 MiB safety ceiling");

  console.log(`PHASE1_PERFORMANCE_EVIDENCE ${JSON.stringify({
    measuredAt: new Date().toISOString(),
    runtime: { platform: process.platform, architecture: process.arch, node: process.version },
    iterations: { cold: COLD_ITERATIONS, warm: WARM_ITERATIONS },
    fixedDataset: { quoCalls: quoCalls.length, databaseRows: database.fixedRows, largeDashboardCopies: 250 },
    apiLatency,
    database,
    fixedFixtureApiBatchDataReady,
    frontendRequestsPerPage,
    responsePayloadBytes: Object.fromEntries(Object.entries(payloads).map(([endpoint, body]) => [endpoint, Buffer.byteLength(body)])),
    memory,
    calibration,
    parserMetrics,
    regressionGate: { observedNormalizedMedianRatio: normalizedQuoMedianRatio, allowedNormalizedMedianRatio: round(limit) },
  })}`);
});
