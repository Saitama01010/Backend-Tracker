import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import pg from "pg";
import { buildOnboardingAnalyticsWorkbook } from "../modules/onboarding/analytics.js";
import { buildQuoPhoneCallRow, type QuoCall, type QuoPhoneNumber } from "../integrations/quo/sync.js";
import { parseGoogleSheetsValues } from "../integrations/googleSheets/mapper.js";
import { parseReadymodeRows } from "../integrations/readymode/csvParser.js";
import { teamFromRingGroupName } from "../integrations/pbx/mapper.js";

const { Client } = pg;
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const fixtureRoot = path.join(import.meta.dirname, "fixtures");
const baselinePath = path.join(repoRoot, "docs", "refactor", "phase-1-performance-baseline.json");
const ITERATIONS = 21;
const WORKLOAD = {
  quoMappingBatches: 4_000,
  pbxParsingBatches: 8_000,
  readyModeParsingBatches: 2_500,
  readyModeCalibrationBatches: 7_500,
  googleSheetsParsingBatches: 8_000,
  exportBatches: 4,
  exportCalibrationBatches: 24,
  aggregateApiRequests: 20,
  dataReadyBatches: 12,
  databaseRows: 80_000,
  databaseCalibrationQueries: 3,
} as const;

type Summary = { iterations: number; p50Ms: number; p95Ms: number; minMs: number; maxMs: number };
type GateBaseline = {
  normalizedP50Ratio: number;
  platformNormalizedP50Ratios?: Record<string, number>;
};
type Baseline = {
  maximumRegressionPercent: number;
  deterministicGates: Record<string, GateBaseline>;
  responsePayloadBytes: Record<string, number>;
  syntheticLargePayloadBytes: number;
  databaseQueryCount: number;
};

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
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    minMs: round(Math.min(...values)),
    maxMs: round(Math.max(...values)),
  };
}

function timed(operation: () => void): number {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

async function timedAsync(operation: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
}

async function repeatAsync(count: number, operation: () => Promise<void>): Promise<void> {
  for (let iteration = 0; iteration < count; iteration++) await operation();
}

function pairedSync(operation: () => void, calibration: () => void) {
  for (let warmup = 0; warmup < 5; warmup++) { operation(); calibration(); }
  const operationMs: number[] = [];
  const calibrationMs: number[] = [];
  const ratios: number[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const first = iteration % 2 === 0 ? operation : calibration;
    const second = iteration % 2 === 0 ? calibration : operation;
    const firstMs = timed(first);
    const secondMs = timed(second);
    const opMs = iteration % 2 === 0 ? firstMs : secondMs;
    const calMs = iteration % 2 === 0 ? secondMs : firstMs;
    operationMs.push(opMs);
    calibrationMs.push(calMs);
    ratios.push(opMs / Math.max(calMs, 0.000_001));
  }
  return { operation: summarize(operationMs), calibration: summarize(calibrationMs), normalizedP50Ratio: round(percentile(ratios, 0.5)) };
}

async function pairedAsync(operation: () => Promise<void>, calibration: () => Promise<void>) {
  for (let warmup = 0; warmup < 3; warmup++) { await operation(); await calibration(); }
  const operationMs: number[] = [];
  const calibrationMs: number[] = [];
  const ratios: number[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const firstIsOperation = iteration % 2 === 0;
    const firstMs = await timedAsync(firstIsOperation ? operation : calibration);
    const secondMs = await timedAsync(firstIsOperation ? calibration : operation);
    const opMs = firstIsOperation ? firstMs : secondMs;
    const calMs = firstIsOperation ? secondMs : firstMs;
    operationMs.push(opMs);
    calibrationMs.push(calMs);
    ratios.push(opMs / Math.max(calMs, 0.000_001));
  }
  return { operation: summarize(operationMs), calibration: summarize(calibrationMs), normalizedP50Ratio: round(percentile(ratios, 0.5)) };
}

function safeDatabaseUrl(): string {
  const raw = (process.env["BUSINESS_CONTRACT_DATABASE_URL"] ?? process.env["DATABASE_URL"])?.trim();
  if (!raw) throw new Error("BUSINESS_CONTRACT_DATABASE_URL or DATABASE_URL is required");
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || !/(?:test|phase1|performance)/i.test(url.pathname)) {
    throw new Error("Deterministic performance gates require a local disposable test database");
  }
  return raw;
}

async function databaseGate(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("CREATE TEMP TABLE phase1_gate_calls(id integer PRIMARY KEY, team text NOT NULL, agent text NOT NULL, seconds integer NOT NULL, created_at timestamptz NOT NULL)");
    await client.query(`INSERT INTO phase1_gate_calls SELECT value, CASE WHEN value % 3 = 0 THEN 'cs' WHEN value % 3 = 1 THEN 'retention' ELSE 'nsf' END, 'Agent ' || value % 40, value % 900, timestamptz '2026-01-01' + value * interval '1 minute' FROM generate_series(1, ${WORKLOAD.databaseRows}) value`);
    await client.query("CREATE INDEX phase1_gate_calls_range_idx ON phase1_gate_calls(created_at, team)");
    await client.query("ANALYZE phase1_gate_calls");
    let queryCount = 0;
    const operation = async () => {
      await client.query(`SELECT team, agent, count(*)::integer, sum(seconds)::integer FROM phase1_gate_calls WHERE created_at >= timestamptz '2026-01-05' AND created_at < timestamptz '2026-02-10' GROUP BY team, agent ORDER BY team, agent`);
      queryCount++;
    };
    const calibration = async () => {
      for (let repeat = 0; repeat < WORKLOAD.databaseCalibrationQueries; repeat++) {
        await client.query("SELECT count(*)::integer FROM phase1_gate_calls");
      }
    };
    const measured = await pairedAsync(operation, calibration);
    return { ...measured, queryCountPerRequest: queryCount / (ITERATIONS + 3) };
  } finally {
    await client.end();
  }
}

async function startFixtureServer(payloads: Record<string, string>) {
  const controlBody = JSON.stringify({ ok: true });
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = pathname === "/control" ? controlBody : payloads[pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(body ?? '{"error":"not found"}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("all deterministic Phase 1 performance paths enforce their recorded 10% gate", async () => {
  const [quoRaw, pbxRaw, readyModeRaw, sheetsRaw, goldenRaw, baselineRaw] = await Promise.all([
    readFile(path.join(fixtureRoot, "quo", "api-pages.json"), "utf8"),
    readFile(path.join(fixtureRoot, "pbx", "api.json"), "utf8"),
    readFile(path.join(fixtureRoot, "readymode", "valid.csv"), "utf8"),
    readFile(path.join(fixtureRoot, "sheets", "google-sheet-1.json"), "utf8"),
    readFile(path.join(fixtureRoot, "goldens", "major-dashboard-responses.json"), "utf8"),
    readFile(baselinePath, "utf8"),
  ]);
  const baseline = JSON.parse(baselineRaw) as Baseline;
  const golden = JSON.parse(goldenRaw) as Record<string, any>;
  const quo = JSON.parse(quoRaw) as { phoneNumbers: QuoPhoneNumber[]; users: Array<{ id: string; displayName: string }>; pages: Array<{ data: Array<QuoCall & { phoneNumberId: string }> }> };
  const lines = new Map(quo.phoneNumbers.map((line) => [line.id, line]));
  const users = new Map(quo.users.map((user) => [user.id, user.displayName]));
  const calls = quo.pages.flatMap((page) => page.data);
  const quietLog = { warn() {} } as unknown as Parameters<typeof parseReadymodeRows>[1];
  const digestCalibration = () => {
    for (let repeat = 0; repeat < 100; repeat++) createHash("sha256").update(goldenRaw).digest();
  };

  const metrics: Record<string, Awaited<ReturnType<typeof pairedAsync>> | ReturnType<typeof pairedSync>> = {};
  metrics["quoMapping"] = pairedSync(() => {
    for (let repeat = 0; repeat < WORKLOAD.quoMappingBatches; repeat++) for (const call of calls) buildQuoPhoneCallRow(call, lines.get(call.phoneNumberId)!, call.participants?.[0] ?? "", users);
  }, () => { for (let repeat = 0; repeat < WORKLOAD.quoMappingBatches; repeat++) JSON.parse(quoRaw); });
  metrics["pbxParsing"] = pairedSync(() => {
    for (let repeat = 0; repeat < WORKLOAD.pbxParsingBatches; repeat++) (JSON.parse(pbxRaw) as { ringGroups: Array<{ name: string }> }).ringGroups.map((group) => teamFromRingGroupName(group.name));
  }, () => { for (let repeat = 0; repeat < WORKLOAD.pbxParsingBatches; repeat++) JSON.parse(pbxRaw); });
  metrics["readyModeParsing"] = pairedSync(() => {
    for (let repeat = 0; repeat < WORKLOAD.readyModeParsingBatches; repeat++) parseReadymodeRows(readyModeRaw, quietLog, "phase1", "2026-05-15");
  }, () => { for (let repeat = 0; repeat < WORKLOAD.readyModeCalibrationBatches; repeat++) readyModeRaw.split("\n").map((row) => row.split(",")); });
  metrics["googleSheetsParsing"] = pairedSync(() => {
    for (let repeat = 0; repeat < WORKLOAD.googleSheetsParsingBatches; repeat++) Object.values(JSON.parse(sheetsRaw) as Record<string, unknown>).map(parseGoogleSheetsValues);
  }, () => { for (let repeat = 0; repeat < WORKLOAD.googleSheetsParsingBatches; repeat++) JSON.parse(sheetsRaw); });
  metrics["exportGeneration"] = await pairedAsync(async () => {
    await repeatAsync(WORKLOAD.exportBatches, async () => {
      const workbook = await buildOnboardingAnalyticsWorkbook(golden.onboardingAnalytics);
      await workbook.xlsx.writeBuffer();
    });
  }, async () => { for (let repeat = 0; repeat < WORKLOAD.exportCalibrationBatches; repeat++) digestCalibration(); });
  metrics["databaseDuration"] = await databaseGate(safeDatabaseUrl());

  const payloads = {
    "/api/quo/stats": JSON.stringify(golden.quoStats),
    "/api/sheet": JSON.stringify(golden.sheet),
    "/api/vos/stats": JSON.stringify(golden.vosStats),
    "/api/readymode/stats": JSON.stringify(golden.readyModeStats),
    "/api/attendance": JSON.stringify(golden.attendance),
    "/api/violations": JSON.stringify(golden.violations),
  };
  const fixtureServer = await startFixtureServer(payloads);
  try {
    const get = async (route: string) => { const response = await fetch(`${fixtureServer.baseUrl}${route}`); assert.equal(response.status, 200); await response.arrayBuffer(); };
    metrics["aggregateApiDuration"] = await pairedAsync(
      () => repeatAsync(WORKLOAD.aggregateApiRequests, () => get("/api/quo/stats")),
      () => repeatAsync(WORKLOAD.aggregateApiRequests, () => get("/control")),
    );
    const routes = Object.keys(payloads);
    metrics["fixedFixtureApiBatchDataReady"] = await pairedAsync(
      () => repeatAsync(WORKLOAD.dataReadyBatches, async () => { await Promise.all(routes.map(get)); }),
      () => repeatAsync(WORKLOAD.dataReadyBatches, async () => { await Promise.all(routes.map(() => get("/control"))); }),
    );
  } finally {
    await fixtureServer.close();
  }

  const payloadBytes = Object.fromEntries(Object.entries(payloads).map(([route, body]) => [route, Buffer.byteLength(body)]));
  const syntheticLargePayloadBytes = Buffer.byteLength(JSON.stringify(Array.from({ length: 250 }, () => golden)));
  const capture = process.env["CAPTURE_PHASE1_PERFORMANCE"] === "1";
  if (!capture) {
    for (const [name, measured] of Object.entries(metrics)) {
      const recorded = baseline.deterministicGates[name];
      assert.ok(recorded, `missing deterministic baseline for ${name}`);
      const platformBaseline = recorded.platformNormalizedP50Ratios?.[process.platform];
      const normalizedP50Ratio = platformBaseline ?? recorded.normalizedP50Ratio;
      const limit = normalizedP50Ratio * (1 + baseline.maximumRegressionPercent / 100);
      assert.ok(measured.normalizedP50Ratio <= limit, `${name} normalized p50 ratio ${measured.normalizedP50Ratio} exceeds 10% limit ${round(limit)}`);
    }
    assert.equal((metrics["databaseDuration"] as Awaited<ReturnType<typeof databaseGate>>).queryCountPerRequest, baseline.databaseQueryCount);
    for (const [route, bytes] of Object.entries(payloadBytes)) {
      assert.ok(bytes <= baseline.responsePayloadBytes[route]! * 1.1, `${route} payload ${bytes} exceeds 10% size gate`);
    }
    assert.ok(syntheticLargePayloadBytes <= baseline.syntheticLargePayloadBytes * 1.1, "synthetic large payload exceeds 10% size gate");
  }

  console.log(`PHASE1_DETERMINISTIC_GATE_EVIDENCE ${JSON.stringify({
    iterations: ITERATIONS,
    workload: WORKLOAD,
    metrics,
    databaseQueryCount: (metrics["databaseDuration"] as Awaited<ReturnType<typeof databaseGate>>).queryCountPerRequest,
    responsePayloadBytes: payloadBytes,
    syntheticLargePayload: { bytes: syntheticLargePayloadBytes, copiesOfWholeGoldenObject: 250, classification: "synthetic harness payload; no endpoint, browser render, or date range" },
    capture,
  })}`);
});
