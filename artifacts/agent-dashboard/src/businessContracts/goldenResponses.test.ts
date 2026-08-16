import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseSheetPayload } from "../lib/sheetData.js";

const goldenPath = path.resolve(
  import.meta.dirname,
  "../../../api-server/src/businessContracts/fixtures/goldens/major-dashboard-responses.json",
);

test("major-dashboard sheet golden keeps the current dashboard parser contract", async () => {
  const golden = JSON.parse(await readFile(goldenPath, "utf8")) as Record<string, any>;
  const parsed = parseSheetPayload(golden.sheet);
  assert.equal(parsed.rows.length, 5);
  assert.equal(parsed.meta?.rowsAccepted, 5);
  assert.deepEqual(parsed.headers, ["Timestamp", "Agent Name", "File ID", "File Status", "Cancel request update", "Notes"]);

  const empty = parseSheetPayload({
    ...golden.sheet,
    rows: [],
    meta: { ...golden.sheet.meta, rowsReceived: 0, rowsAccepted: 0 },
  });
  assert.deepEqual(empty.rows, []);
});
