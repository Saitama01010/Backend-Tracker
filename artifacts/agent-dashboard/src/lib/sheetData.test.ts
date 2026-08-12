import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  loadBackendStatsSheetSources,
  parseSheetPayload,
  readSheetResponse,
  type SheetPayload,
} from "./sheetData.js";

const sources = {
  retainedCancels: "retained-cancels",
  fixes: "fixes",
  idpHandled: "idp-handled",
  idpCancelRetained: "idp-cancel-retained",
};

test("approved successful sheet responses preserve populated and genuinely empty data", async () => {
  const populated = { headers: ["Agent", "Status"], rows: [{ Agent: "Sanitized Agent", Status: "Fixed" }] };
  assert.deepEqual(await readSheetResponse(new Response(JSON.stringify(populated), { status: 200 })), populated);

  const empty = { headers: ["Agent", "Status"], rows: [] };
  assert.deepEqual(await readSheetResponse(new Response(JSON.stringify(empty), { status: 200 })), empty);
  assert.deepEqual(parseSheetPayload({ headers: [], rows: [] }), { headers: [], rows: [] });
});

test("compact sheet rows reconstruct the legacy mapping exactly", () => {
  const compact = {
    format: "rows-v1",
    headers: ["Agent", "Status"],
    columns: ["Agent", "Status", ""],
    rows: [["Sanitized Agent", "Fixed", "fallback value"]],
    meta: {
      fetchedAt: "2026-08-12T12:00:00.000Z",
      observedAt: "2026-08-12T12:00:01.000Z",
      stale: false,
      refreshError: false,
      cache: "miss",
      rowsReceived: 1,
      rowsAccepted: 1,
      rowsSkipped: 0,
    },
  };
  const parsed = parseSheetPayload(compact);
  assert.deepEqual(parsed.rows, [{
    Agent: "Sanitized Agent",
    Status: "Fixed",
    __col0: "Sanitized Agent",
    __col1: "Fixed",
    __col2: "fallback value",
  }]);
  assert.deepEqual(parsed.meta, compact.meta);
  const compactMany = { ...compact, rows: Array.from({ length: 100 }, () => compact.rows[0]) };
  const legacyMany = {
    headers: compact.headers,
    rows: Array.from({ length: 100 }, () => parsed.rows[0]),
  };
  assert.ok(JSON.stringify(compactMany).length < JSON.stringify(legacyMany).length);
});

test("500, 502, malformed, and non-JSON sheet responses remain failures", async () => {
  await assert.rejects(() => readSheetResponse(new Response("{}", { status: 500 })), /HTTP 500/);
  await assert.rejects(() => readSheetResponse(new Response("{}", { status: 502 })), /HTTP 502/);
  await assert.rejects(
    () => readSheetResponse(new Response(JSON.stringify({ headers: [], rows: "not-an-array" }), { status: 200 })),
    /invalid response/,
  );
  await assert.rejects(() => readSheetResponse(new Response("not-json", { status: 200 })), /invalid response/);
});

test("Backend Statistics propagates every required provider failure instead of substituting zero rows", async () => {
  const empty: SheetPayload = { headers: ["Agent", "Status"], rows: [] };
  const loaded = await loadBackendStatsSheetSources(async () => empty, sources);
  assert.deepEqual(loaded, {
    retainedCancels: empty,
    fixes: empty,
    idpHandled: empty,
    idpCancelRetained: empty,
  });

  for (const failedSource of Object.values(sources)) {
    await assert.rejects(
      () => loadBackendStatsSheetSources(async (source) => {
        if (source === failedSource) throw new Error("provider unavailable");
        return empty;
      }, sources),
      /provider unavailable/,
      failedSource,
    );
  }

  await assert.rejects(
    () => loadBackendStatsSheetSources(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }, sources),
    /timed out/,
  );
});

test("Backend Statistics requests independent cached sources in parallel", async () => {
  const empty: SheetPayload = { headers: [], rows: [] };
  const starts: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const pending = loadBackendStatsSheetSources(async (source) => {
    starts.push(source);
    if (starts.length === 4) release();
    await barrier;
    return empty;
  }, sources);
  await pending;
  assert.deepEqual(new Set(starts), new Set(Object.values(sources)));
});

test("Backend Statistics renders a retryable provider error instead of zero KPI cards", async () => {
  const app = await readFile(path.resolve(import.meta.dirname, "..", "App.tsx"), "utf8");
  const loader = app.match(/async function fetchBackendStatsSubmissions[\s\S]*?function fetchBackendStatsSheetForTeam/)?.[0] ?? "";
  const panel = app.match(/function BackendStatsPanel\(\)[\s\S]*?function [A-Za-z]+Panel/)?.[0] ?? app.slice(app.indexOf("function BackendStatsPanel()"));
  assert.match(loader, /loadBackendStatsSheetSources/);
  assert.doesNotMatch(loader, /\.catch\(\(\) => \(\{ headers: \[\]/);
  assert.match(panel, /if \(isError\)/);
  assert.match(panel, /Google Sheets data is temporarily unavailable\./);
  assert.match(panel, /onClick=\{\(\) => refetch\(\)\}/);
});
