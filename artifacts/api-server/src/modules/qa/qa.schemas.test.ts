import assert from "node:assert/strict";
import test from "node:test";
import {
  parseQaDateBasisQuery,
  parseQaDepartment,
  parseQaEvaluationRequest,
  parseQaListLimit,
  parseQaRequestDateRange,
  parseQaTaskResolution,
} from "./qa.schemas.js";

test("QA request schemas preserve department and date-basis defaults", () => {
  assert.deepEqual(parseQaDepartment(undefined), { ok: true, requested: null });
  assert.deepEqual(parseQaDepartment("ALL"), { ok: true, requested: null });
  assert.deepEqual(parseQaDepartment(" retention "), { ok: true, requested: "Retention" });
  assert.deepEqual(parseQaDepartment("sales"), { ok: false, error: "Invalid department." });
  assert.deepEqual(parseQaDateBasisQuery(undefined), { ok: true, dateBasis: "evaluated" });
  assert.deepEqual(parseQaDateBasisQuery("call"), { ok: true, dateBasis: "call" });
  assert.deepEqual(parseQaDateBasisQuery("created"), {
    ok: false,
    error: "dateBasis must be evaluated or call",
  });
});

test("QA date-range defaults remain the prior 30-day window", () => {
  const now = new Date("2026-08-16T12:30:00.000Z");
  const parsed = parseQaRequestDateRange({}, now);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.from.toISOString(), "2026-07-17T12:30:00.000Z");
  assert.equal(parsed.to.toISOString(), now.toISOString());
});

test("manual QA validation preserves call ID, force, and idempotency behavior", () => {
  assert.deepEqual(parseQaEvaluationRequest({ callId: " bad id " }, undefined), {
    ok: false,
    error: "A valid QUO callId is required",
  });
  assert.deepEqual(parseQaEvaluationRequest({ callId: "AC1234567890abcdef" }, "short"), {
    ok: false,
    error: "Idempotency-Key is invalid",
  });
  assert.deepEqual(
    parseQaEvaluationRequest(
      { callId: " AC1234567890abcdef ", force: true },
      " qa-call:AC1234567890abcdef ",
    ),
    {
      ok: true,
      value: {
        callId: "AC1234567890abcdef",
        force: true,
        rawIdempotencyKey: "qa-call:AC1234567890abcdef",
      },
    },
  );
});

test("QA list and manager-resolution parsing preserve legacy coercions", () => {
  assert.equal(parseQaListLimit(undefined), 100);
  assert.equal(parseQaListLimit("0"), 100);
  assert.equal(parseQaListLimit("900"), 500);
  assert.deepEqual(parseQaTaskResolution({
    notes: " note ",
    comments: " ",
    coachingComplete: 1,
    managerScore: "101.6",
  }), {
    notes: "note",
    comments: null,
    coachingComplete: true,
    managerScore: 100,
  });
});
