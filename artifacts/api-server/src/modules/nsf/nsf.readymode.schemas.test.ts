import assert from "node:assert/strict";
import test from "node:test";
import {
  formatNsfReadymodePhone,
  normalizeNsfReadymodePhone,
  parseNsfReadymodeDoneNumber,
  parseNsfReadymodeId,
  parseNsfReadymodeNumbers,
  resolveNsfReadymodeActor,
} from "./nsf.readymode.schemas.js";

test("NSF ReadyMode queue input preserves normalization, de-duplication, and validation messages", () => {
  assert.deepEqual(parseNsfReadymodeNumbers([
    "+1 (202) 555-0101",
    "2025550101",
    "2025550102 ext 9",
    2025550103,
    "short",
  ]), { ok: true, value: ["2025550101", "0255501029"] });
  assert.deepEqual(parseNsfReadymodeNumbers(undefined), {
    ok: false,
    error: "No valid 10-digit numbers provided.",
  });
  assert.deepEqual(parseNsfReadymodeNumbers(["short", 2025550103]), {
    ok: false,
    error: "No valid 10-digit numbers provided.",
  });
});

test("NSF ReadyMode queue preserves phone display and command parsing", () => {
  assert.equal(normalizeNsfReadymodePhone("+1 (202) 555-0101"), "2025550101");
  assert.equal(formatNsfReadymodePhone("2025550101"), "(202) 555-0101");
  assert.equal(formatNsfReadymodePhone("123"), "123");
  assert.equal(parseNsfReadymodeId("7"), 7);
  assert.equal(parseNsfReadymodeId("0"), null);
  assert.equal(parseNsfReadymodeId("7.5"), null);
  assert.equal(parseNsfReadymodeDoneNumber("+1 (202) 555-0101"), "2025550101");
  assert.equal(parseNsfReadymodeDoneNumber("short"), null);
});

test("NSF ReadyMode queue preserves explicit actor and authenticated fallback semantics", () => {
  assert.equal(resolveNsfReadymodeActor(" Samia ", "admin", "samia"), "Samia");
  assert.equal(resolveNsfReadymodeActor("", "admin", "samia"), "admin");
  assert.equal(resolveNsfReadymodeActor(undefined, undefined, "manual"), "manual");
});
