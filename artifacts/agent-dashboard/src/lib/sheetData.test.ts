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
