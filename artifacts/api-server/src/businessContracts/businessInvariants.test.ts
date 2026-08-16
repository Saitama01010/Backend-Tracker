import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const fixtureRoot = path.join(import.meta.dirname, "fixtures", "sheets");
const appSourceUrl = new URL("../../../agent-dashboard/src/App.tsx", import.meta.url);

test("Google Sheet 2 rows contribute to Retained while IDP Handled, Retained, Fixed, and Cancelled remain separate", async () => {
  const sheet2 = JSON.parse(await readFile(path.join(fixtureRoot, "google-sheet-2.json"), "utf8")) as {
    idpHandledRetained: { values: string[][] };
  };
  const [header, ...sourceRows] = sheet2.idpHandledRetained.values.slice(1);
  assert.deepEqual(header, ["Timestamp", "Agent Name", "File ID", "Notes"]);
  const validSheet2Rows = sourceRows.filter((row) => /^\d/.test(row[0] ?? "") && row[1]);
  assert.equal(validSheet2Rows.length, 3);

  const appSource = await readFile(appSourceUrl, "utf8");
  const sheet2Block = appSource.match(/for \(const r of idpCancelSheet\.rows\)[\s\S]*?__sourceTab: "IDP-Cancel-Retained"[\s\S]*?\n  }/)?.[0] ?? "";
  assert.match(sheet2Block, /Status: "Retained"/);
  assert.doesNotMatch(sheet2Block, /detectKeywordStatus/);
  assert.match(appSource, /function isRetainedStatus[\s\S]*?\/retain\/\.test\(lower\)[\s\S]*?\/\\bidp\\b\/\.test\(lower\)/);
  assert.match(appSource, /function isPureRetainedStatus[\s\S]*?if \(\/\\bidp\\b\/\.test\(lower\)\) return false;/);
  assert.match(appSource, /if \(\/\^activehandled\$\/\.test\(l\)\) return "IDP-Handled";/);
});

test("current PBX display-name aliases remain unchanged", async () => {
  const appSource = (await readFile(appSourceUrl, "utf8")).replace(/\r\n/g, "\n");
  const blockDigest = (marker: string) => {
    const start = appSource.indexOf(marker);
    const end = appSource.indexOf("};", start) + 2;
    assert.ok(start >= 0 && end > start, `${marker} must remain present`);
    return createHash("sha256").update(appSource.slice(start, end)).digest("hex");
  };
  assert.equal(blockDigest("const PBX_TO_DISPLAY_NAME"), "faa048298d791d750b50a4f69e22286a05cf3b3d819fc9540faa90df3e4cc843");
  assert.equal(blockDigest("const SHEET_TO_PBX"), "40b836de55fb3e82d327eb75cd588fb7d28bd8e7e2db5241b10111e14340b63e");
  assert.match(appSource, /return SHEET_TO_PBX\[norm\] \?\? norm;/);
});

test("duplicate-looking rows remain counted as separate current rows", async () => {
  const appSource = await readFile(appSourceUrl, "utf8");
  const aggregateBlock = appSource.slice(appSource.indexOf("function aggregate("), appSource.indexOf("function StatTile("));
  assert.match(aggregateBlock, /const filteredStatus = status\.rows\.filter/);
  assert.match(aggregateBlock, /for \(const r of filteredStatus\)/);
  assert.doesNotMatch(aggregateBlock, /new Set\(status\.rows|uniqueBy|dedup/i);
});
