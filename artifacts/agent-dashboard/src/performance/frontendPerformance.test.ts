import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const srcRoot = path.resolve(import.meta.dirname, "..");

test("heavy chart, onboarding, AI, and CSV code stay out of the initial module graph", async () => {
  const app = await readFile(path.join(srcRoot, "App.tsx"), "utf8");
  assert.match(app, /React\.lazy\(\(\) =>\s*import\("\.\/OnboardingPanel"\)/);
  assert.match(app, /React\.lazy\(\(\) => import\("\.\/features\/backend-stats\/BackendStatsCharts"\)\)/);
  assert.match(app, /async function activate\(\)[\s\S]*import\("\.\/features\/samia\/SamiaChat"\)/);
  assert.doesNotMatch(app, /from "recharts"/);
  assert.doesNotMatch(app, /from "papaparse"/);
});

test("shared requests and polling preserve account and activity boundaries", async () => {
  const app = await readFile(path.join(srcRoot, "App.tsx"), "utf8");
  const intervalLines = app.split(/\r?\n/).filter((line) => line.includes("refetchInterval:"));
  assert.ok(intervalLines.length >= 20, "expected the dashboard polling inventory to remain covered");
  for (const line of intervalLines) {
    assert.match(line, /queryPollingInterval|pollingDelay/, `non-centralized interval: ${line.trim()}`);
  }
  assert.match(app, /queryKey: \["sheet-source", scope, id, gid\]/);
  assert.match(app, /queryKey: \["phoneStats", from, to\]/);
  assert.doesNotMatch(app, /queryKey: \["phoneStats", (?:mode|"cs"|"retention")/);
  assert.doesNotMatch(app, /queryKey: \["rmkPhoneStats"/);
  assert.doesNotMatch(app, /new URLSearchParams\(\{ id, gid, _:/);
  assert.ok((app.match(/clearDashboardQueryCache\(\)/g) ?? []).length >= 2);
});

test("large rows remain present while browser-native rendering skips offscreen work", async () => {
  const app = await readFile(path.join(srcRoot, "App.tsx"), "utf8");
  const table = await readFile(path.join(srcRoot, "components", "ui", "table.tsx"), "utf8");
  const css = await readFile(path.join(srcRoot, "index.css"), "utf8");
  assert.match(table, /virtualized-table-row/);
  assert.match(css, /content-visibility:\s*auto/);
  assert.match(css, /contain-intrinsic-block-size:\s*auto 44px/);
  assert.doesNotMatch(table, /aria-hidden/);
  assert.ok((app.match(/usePaginatedRows\(/g) ?? []).length >= 3);
});

test("expensive table searches use the shared debounce hook", async () => {
  const app = await readFile(path.join(srcRoot, "App.tsx"), "utf8");
  assert.ok((app.match(/useDebouncedValue\(search\)/g) ?? []).length >= 6);
});

test("PBX request failures remain explicit instead of becoming zero-valued dashboard data", async () => {
  const app = await readFile(path.join(srcRoot, "App.tsx"), "utf8");
  const sharedPbxHook = app.match(/function useVosStats\(\)[\s\S]*?function useVosRingGroupMissed/)?.[0] ?? "";
  const pbxPanel = app.match(/function VoSPanel\(\)[\s\S]*?interface RmAgentStat/)?.[0] ?? "";

  assert.match(sharedPbxHook, /if \(!r\.ok\) throw new Error\("Failed to load VoSLogic stats"\)/);
  assert.doesNotMatch(sharedPbxHook, /return \{ dashboard: \{ callsByAgent: \[\] \}/);
  assert.match(pbxPanel, /if \(!r\.ok\) throw new Error\("Failed to load VoSLogic live state"\)/);
  assert.match(pbxPanel, /\{\(q\.error \|\| liveQ\.error\) && \(/);
  assert.match(pbxPanel, /PBX data is temporarily unavailable\./);
  assert.doesNotMatch(app, /if \(!r\.ok\) return \{ liveCalls: \[\], agentStatuses: \[\] \};/);
  assert.match(app, /PBX live status is temporarily unavailable\. Historical totals are unchanged\./);
});
