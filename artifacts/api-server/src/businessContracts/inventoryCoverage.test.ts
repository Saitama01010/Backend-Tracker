import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const inventoryPath = path.join(repoRoot, "docs", "refactor", "phase-1-current-behavior-map.json");

type Inventory = {
  dashboardPages: Array<{ id: string; endpoints: string[]; exports: string[] }>;
  routeGroups: Array<{ owner: string; endpoints: string[]; tables: string[]; externalSources: string[]; caches: string[] }>;
  externalInputs: Array<{ id: string; fixture: string }>;
  backgroundJobs: unknown[];
  importWorkflows: unknown[];
  exports: unknown[];
};

async function inventory(): Promise<Inventory> {
  return JSON.parse(await readFile(inventoryPath, "utf8")) as Inventory;
}

test("machine behavior map covers every current Express route declaration", async () => {
  const map = await inventory();
  const routeDir = path.join(repoRoot, "artifacts", "api-server", "src", "routes");
  const routeFiles = (await readdir(routeDir)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const sources = await Promise.all(routeFiles.map((name) => readFile(path.join(routeDir, name), "utf8")));
  const declared = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
      declared.add(`${match[1]!.toUpperCase()} ${match[2]!}`);
    }
  }
  assert.equal(declared.size, 99, "review the behavior map when production routes are added or removed");

  const mapped = new Set(map.routeGroups.flatMap((group) => group.endpoints));
  for (const endpoint of declared) assert.ok(mapped.has(endpoint), `unmapped production endpoint: ${endpoint}`);
  for (const endpoint of mapped) {
    if (endpoint === "HEAD /healthz") continue;
    assert.ok(declared.has(endpoint), `stale mapped endpoint: ${endpoint}`);
  }
  assert.ok(mapped.has("GET /healthz") && mapped.has("HEAD /healthz"));
});

test("every dashboard endpoint resolves to a traced route group and every page has smoke ownership", async () => {
  const map = await inventory();
  const routed = new Set(map.routeGroups.flatMap((group) => group.endpoints));
  assert.equal(map.dashboardPages.length, 19);
  for (const page of map.dashboardPages) {
    assert.ok(page.id);
    assert.ok(page.endpoints.length > 0, `${page.id} needs at least one endpoint mapping`);
    for (const endpoint of page.endpoints) assert.ok(routed.has(endpoint), `${page.id}: ${endpoint}`);
  }
});

test("all five external paths, jobs, imports, caches, exports, and route-table mappings are explicit", async () => {
  const map = await inventory();
  assert.deepEqual(map.externalInputs.map((source) => source.id), [
    "quo",
    "pbx",
    "readymode",
    "google-sheet-1",
    "google-sheet-2",
  ]);
  for (const source of map.externalInputs) {
    const target = path.join(repoRoot, source.fixture);
    await assert.doesNotReject(async () => (await import("node:fs/promises")).stat(target), source.fixture);
  }
  assert.ok(map.backgroundJobs.length >= 7);
  assert.ok(map.importWorkflows.length >= 5);
  assert.ok(map.exports.length >= 8);
  for (const group of map.routeGroups) {
    assert.ok(Array.isArray(group.tables), `${group.owner} tables`);
    assert.ok(Array.isArray(group.externalSources), `${group.owner} external sources`);
    assert.ok(Array.isArray(group.caches), `${group.owner} caches`);
  }
});
