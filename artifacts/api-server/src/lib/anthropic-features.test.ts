import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { extractQuoCallId, getQuoCallArtifacts } from "./quoCall.js";
import { assistantBlocks, toolResultMessage, validateSamiaPayload } from "./samiaPolicy.js";
import {
  hasRecentAutomaticReview,
  shouldReuseStoredReview,
  stableEligibleCalls,
  validateQaResult,
} from "./qaPolicy.js";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.resolve(libDir, "../routes");

test("Samia accepts a valid request only after payload validation", () => {
  const valid = validateSamiaPayload({ message: "hello", images: ["data:image/png;base64,AA=="] });
  assert.equal(valid.ok, true);
  const invalid = validateSamiaPayload({ message: " ", images: [] });
  assert.deepEqual(invalid, { ok: false, status: 400, error: "message is required" });
});

test("application/module startup performs zero Anthropic requests", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network request");
  }) as typeof fetch;
  try {
    await import("./anthropic.js");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing Anthropic key fails safely without a request", async () => {
  process.env["ANTHROPIC_API_KEY"] = "";
  const { createAnthropicClient, AnthropicConfigurationError } = await import("./anthropic.js");
  assert.throws(() => createAnthropicClient(), AnthropicConfigurationError);
});

test("Samia route invokes Claude only inside the authenticated chat handler", async () => {
  const source = await readFile(path.join(routesDir, "samia.ts"), "utf8");
  const routeStart = source.indexOf('router.post("/samia/chat", requireAuth, requireRole("admin")');
  assert.ok(routeStart > 0);
  assert.ok(source.indexOf("withDurableAiLimit", routeStart) > routeStart);
  assert.ok(source.indexOf("createSamiaMessage", routeStart) > routeStart);
  assert.equal(source.includes("claude-test"), false);
  assert.equal(source.includes("openrouter-test"), false);
});

test("supported pasted QUO call-ID forms are recognized and validated", () => {
  const id = "AC1234567890abcdef";
  assert.equal(extractQuoCallId(`Analyze call ID: ${id}`), id);
  assert.equal(extractQuoCallId(`Listen to this call: ${id}`), id);
  assert.equal(extractQuoCallId(`Review ${id}`), id);
  assert.equal(extractQuoCallId(id), id);
  assert.equal(extractQuoCallId("../../etc/passwd"), null);
});

test("pasted call ID fetches its real QUO transcript and summary", async () => {
  process.env["QUO_API_KEY"] = "mock-key";
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("call-transcripts")) {
      return new Response(JSON.stringify({ data: { status: "completed", dialogue: [{ identifier: "Agent", content: "Verified transcript" }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { status: "completed", summary: ["Verified summary"], nextSteps: ["Follow up"] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await getQuoCallArtifacts("AC1234567890abcdef");
    assert.equal(result.status, "ready");
    assert.match(result.transcriptText, /Verified transcript/);
    assert.deepEqual(result.summary, ["Verified summary"]);
    assert.equal(urls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("nonexistent QUO call ID returns call not found", async () => {
  process.env["QUO_API_KEY"] = "mock-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  try {
    assert.equal((await getQuoCallArtifacts("AC1234567890abcdef")).status, "not_found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unavailable QUO transcript is explicit and contains no invented dialogue", async () => {
  process.env["QUO_API_KEY"] = "mock-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("call-transcripts")
      ? { data: { status: "in-progress", dialogue: [] } }
      : { data: { status: "completed", summary: ["Summary only"] } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await getQuoCallArtifacts("AC1234567890abcdef");
    assert.equal(result.status, "transcript_unavailable");
    assert.equal(result.transcriptText, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic tool_use and tool_result blocks retain native formatting", () => {
  const message = {
    content: [
      { type: "text", text: "Checking" },
      { type: "tool_use", id: "toolu_1", name: "lookup_number", input: { number: "5551234567" } },
    ],
  } as unknown as Anthropic.Message;
  assert.deepEqual(assistantBlocks(message), [
    { type: "text", text: "Checking" },
    { type: "tool_use", id: "toolu_1", name: "lookup_number", input: { number: "5551234567" } },
  ]);
  assert.deepEqual(toolResultMessage([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]), {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
  });
});

interface FakeState {
  locks: Set<string>;
  usage: Array<{ feature: string; userId: number; at: number }>;
}

function fakePool(state: FakeState) {
  return {
    async connect() {
      return {
        async query(text: string, values: Array<string | number> = []) {
          if (text.includes("pg_try_advisory_lock")) {
            const key = values.join(":");
            const acquired = !state.locks.has(key);
            if (acquired) state.locks.add(key);
            return { rows: [{ acquired }] };
          }
          if (text.includes("pg_advisory_unlock")) {
            state.locks.delete(values.join(":"));
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          if (text.includes("FROM ai_request_usage")) {
            const now = Date.now();
            const feature = String(values[0]);
            const userId = Number(values[1]);
            const rows = state.usage.filter((row) => row.feature === feature && row.userId === userId);
            return { rows: [{
              minute_count: rows.filter((row) => row.at >= now - 60_000).length,
              day_count: rows.filter((row) => row.at >= now - 86_400_000).length,
              minute_retry: 60,
              day_retry: 86_400,
            }] };
          }
          if (text.includes("INSERT INTO ai_request_usage")) {
            state.usage.push({ feature: String(values[0]), userId: Number(values[1]), at: Date.now() });
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

test("Samia limits persist across separate server/pool instances", async () => {
  process.env["DATABASE_URL"] = "postgres://unused:unused@localhost/unused";
  const { withDurableAiLimit, AiRateLimitError } = await import("./aiRateLimit.js");
  const state: FakeState = { locks: new Set(), usage: [] };
  await withDurableAiLimit({ feature: "samia_chat", userId: 7, perMinute: 1, perDay: 50 }, async () => "ok", fakePool(state) as never);
  await assert.rejects(
    withDurableAiLimit({ feature: "samia_chat", userId: 7, perMinute: 1, perDay: 50 }, async () => "no", fakePool(state) as never),
    AiRateLimitError,
  );
});

test("two server instances cannot hold the same active generation lock", async () => {
  process.env["DATABASE_URL"] = "postgres://unused:unused@localhost/unused";
  const { withDurableAiLimit, AiRateLimitError } = await import("./aiRateLimit.js");
  const state: FakeState = { locks: new Set(), usage: [] };
  let releaseFirst!: () => void;
  const first = withDurableAiLimit(
    { feature: "samia_chat", userId: 9, perMinute: 6, perDay: 50 },
    () => new Promise<void>((resolve) => { releaseFirst = resolve; }),
    fakePool(state) as never,
  );
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    withDurableAiLimit({ feature: "samia_chat", userId: 9, perMinute: 6, perDay: 50 }, async () => undefined, fakePool(state) as never),
    AiRateLimitError,
  );
  releaseFirst();
  await first;
});

test("two Vercel instances cannot hold the same QA scheduler lease", async () => {
  process.env["DATABASE_URL"] = "postgres://unused:unused@localhost/unused";
  const { withDatabaseLease, AiRateLimitError } = await import("./aiRateLimit.js");
  const state: FakeState = { locks: new Set(), usage: [] };
  let releaseFirst!: () => void;
  const first = withDatabaseLease(
    "qa_auto_biweekly",
    () => new Promise<void>((resolve) => { releaseFirst = resolve; }),
    fakePool(state) as never,
  );
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    withDatabaseLease("qa_auto_biweekly", async () => undefined, fakePool(state) as never),
    AiRateLimitError,
  );
  releaseFirst();
  await first;
});

test("one automatic review blocks another within 14 days", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  assert.equal(hasRecentAutomaticReview([{ source: "auto_biweekly", evaluatedAt: new Date("2026-07-10T00:00:00Z") }], now, 14), true);
});

test("repeated scheduler eligibility checks remain idempotent", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  const reviews: Array<{ source: string; evaluatedAt: Date }> = [];
  assert.equal(hasRecentAutomaticReview(reviews, now, 14), false);
  reviews.push({ source: "auto_biweekly", evaluatedAt: now });
  assert.equal(hasRecentAutomaticReview(reviews, now, 14), true);
});

test("manual call-ID reviews do not consume automatic allowance", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  assert.equal(hasRecentAutomaticReview([{ source: "manual_call_id", evaluatedAt: new Date("2026-07-14T00:00:00Z") }], now, 14), false);
});

test("scheduler selection is deterministic and excludes already-reviewed calls", () => {
  const calls = [
    { id: "A", durationSeconds: 120, createdAt: new Date("2026-07-13T00:00:00Z") },
    { id: "B", durationSeconds: 180, createdAt: new Date("2026-07-12T00:00:00Z") },
    { id: "C", durationSeconds: 180, createdAt: new Date("2026-07-14T00:00:00Z") },
  ];
  assert.deepEqual(stableEligibleCalls(calls, new Set(["C"]), 90).map((call) => call.id), ["B", "A"]);
});

test("existing reviews are reused unless an admin explicitly forces reevaluation", async () => {
  assert.equal(shouldReuseStoredReview({ id: "call" }, false), true);
  assert.equal(shouldReuseStoredReview({ id: "call" }, true), false);
  const source = await readFile(path.join(routesDir, "qa.ts"), "utf8");
  assert.match(source, /router\.post\("\/qa\/evaluate", requireAuth, requireRole\("admin"\)/);
  assert.match(source, /existingWasAutomatic \? "auto_biweekly" : "manual_call_id"/);
});

test("QA validation rejects malformed scores without a retry", () => {
  assert.equal(validateQaResult({ categoryScores: { greeting: 101 }, softSkillsScore: 50, protocolScore: 50 }, "CS"), null);
  const valid = validateQaResult({
    department: "CS",
    categoryScores: {
      greeting: 7,
      empathy: 10,
      ownership: 10,
      professionalism: 5,
      closing: 8,
      attemptedResolution: 15,
      avoidedUnnecessaryTransfer: 10,
      handledCancellationConcerns: 10,
      properWarmTransfer: 5,
      accurateCallbackExpectations: 5,
      accurateInformation: 10,
      followedSupportWorkflow: 5,
    },
    score: 1,
    softSkillsScore: 1,
    protocolScore: 1,
    pass: false,
    criticalFail: false,
    strengths: ["Clear"],
    missedItems: [],
    criticalIssues: [],
    reason: "Good",
    managerReviewRequired: true,
  }, "CS");
  assert.equal(valid?.score, 100);
  assert.equal(valid?.softSkillsScore, 100);
  assert.equal(valid?.protocolScore, 100);
  assert.equal(valid?.pass, true);
});

test("existing Samia frontend response fields remain present", async () => {
  const source = await readFile(path.join(routesDir, "samia.ts"), "utf8");
  assert.match(source, /reply: finalReply/);
  assert.match(source, /attendanceMarked/);
  assert.match(source, /fallbackUsed: false/);
});
