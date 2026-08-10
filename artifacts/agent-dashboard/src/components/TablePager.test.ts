import assert from "node:assert/strict";
import test from "node:test";
import { LARGE_TABLE_PAGE_SIZE, pageRows } from "./TablePager.js";

test("large table pagination preserves every row exactly once", () => {
  const rows = Array.from({ length: 250 }, (_, index) => ({ id: index + 1 }));
  const pages = [0, 1, 2].flatMap((page) => pageRows(rows, page));
  assert.equal(LARGE_TABLE_PAGE_SIZE, 100);
  assert.deepEqual(pages, rows);
  assert.equal(pageRows(rows, 0).length, 100);
  assert.equal(pageRows(rows, 2).length, 50);
});
