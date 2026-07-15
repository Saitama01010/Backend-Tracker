import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { extractQuoCallId, getQuoCallArtifacts } from "./quoCall.js";
import {
  appendVerifiedCallEvidenceBasis,
  assistantBlocks,
  claudeModelDisplayName,
  deterministicIdentityReply,
  extractUsPhoneNumber,
  hasVisibleInternalToolSyntax,
  isModelIdentityQuestion,
  isStaleModelIdentityMessage,
  mapSamiaError,
  safeVisibleSamiaReply,
  shouldRoutePhoneNumberToCallData,
  toolResultMessage,
  validateSamiaPayload,
} from "./samiaPolicy.js";
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
  const invalidImage = validateSamiaPayload({ message: "hello", images: ["data:text/plain;base64,AA=="] });
  assert.equal(invalidImage.ok, false);
});

test("Samia identity questions are deterministic and use the configured Claude model", () => {
  const questions = [
    "what model are you",
    "what's your model?",
    "which model do you use",
    "which AI are you",
    "are you GPT-4",
    "are you ChatGPT",
    "are you Claude",
    "are you OpenAI",
    "who powers you",
    "what are you powered by",
    "who made you",
    "what provider do you use",
    "tell me your model",
    "which provider powers you",
    "do you use OpenRouter",
    "what LLM are you using",
  ];
  for (const question of questions) assert.equal(isModelIdentityQuestion(question), true, question);
  assert.equal(isModelIdentityQuestion("Tell me about OpenAI as a company"), false);
  assert.equal(claudeModelDisplayName("claude-sonnet-5"), "Claude Sonnet 5");
  assert.equal(claudeModelDisplayName("claude-haiku-4-5"), "Claude Haiku 4.5");
  assert.equal(claudeModelDisplayName("claude-unknown-preview"), "claude-unknown-preview");
  assert.equal(
    deterministicIdentityReply("claude-sonnet-5"),
    "I'm Samia, powered by Anthropic Claude using Claude Sonnet 5.",
  );
});

test("only stale false assistant identity claims are removed from Claude context", () => {
  for (const claim of [
    "I am GPT-4.",
    "I'm powered by OpenAI.",
    "I use ChatGPT.",
    "My model is GPT-4 Turbo.",
    "I run on Qwen.",
    "I was created by OpenAI.",
    "As a Gemini model, I can help.",
  ]) {
    assert.equal(isStaleModelIdentityMessage("assistant", claim), true, claim);
  }
  assert.equal(isStaleModelIdentityMessage("user", "Are you GPT-4?"), false);
  assert.equal(isStaleModelIdentityMessage("assistant", "OpenAI is an AI company."), false);
  assert.equal(isStaleModelIdentityMessage("assistant", 'The customer said, "I use ChatGPT for work."'), false);
  assert.equal(isStaleModelIdentityMessage("assistant", "I'm powered by Anthropic Claude."), false);
});

test("US phone extraction normalizes supported formats and masks logs", () => {
  for (const input of [
    "850-812-0151",
    "(850) 812-0151",
    "+1 850 812 0151",
    "8508120151",
    "1-850-812-0151",
  ]) {
    const result = extractUsPhoneNumber(input);
    assert.equal(result.found, true, input);
    if (!result.found) continue;
    assert.equal(result.digits, "8508120151");
    assert.equal(result.e164, "+18508120151");
    assert.equal(result.masked, "******0151");
    assert.ok(result.original.length >= 10);
  }
  assert.deepEqual(extractUsPhoneNumber("order 123456"), { found: false });
});

test("casual phone messages route to verified call data without intent keywords", () => {
  for (const message of [
    "850-812-0151 spell the tea",
    "850-812-0151 spill the tea",
    "850-812-0151 give me the tea",
    "tell me about 850-812-0151",
    "what's the story with 850-812-0151",
    "check 8508120151",
    "look up 8508120151",
    "investigate 8508120151",
    "what happened with 8508120151",
    "who spoke with 8508120151",
    "8508120151",
  ]) {
    assert.equal(shouldRoutePhoneNumberToCallData(message), true, message);
  }
  assert.equal(shouldRoutePhoneNumberToCallData("My phone number is 8508120151"), false);
  assert.equal(shouldRoutePhoneNumberToCallData("Format this phone number 8508120151"), false);
});

test("internal Samia operation syntax can never reach a visible reply", () => {
  const fakeCall = '**analyze_calls**\n```json\n{"participant":"8508120151"}\n```';
  assert.equal(hasVisibleInternalToolSyntax(fakeCall), true);
  assert.equal(hasVisibleInternalToolSyntax('analyze_calls({ participant: "8508120151" })'), true);
  assert.equal(safeVisibleSamiaReply(fakeCall), "I couldn't complete that dashboard lookup safely. Please try again.");
  assert.equal(safeVisibleSamiaReply("I found two verified calls."), "I found two verified calls.");
});

test("call analysis replies always disclose their verified non-audio basis", () => {
  assert.match(appendVerifiedCallEvidenceBasis("The customer asked to cancel."), /verified QUO\/OpenPhone transcript or summary data/);
  const exactCall = appendVerifiedCallEvidenceBasis("The agent handled it well.", "AC1234567890abcdef");
  assert.match(exactCall, /AC1234567890abcdef/);
  assert.match(exactCall, /not audio/);
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

test("dashboard application import performs zero Anthropic requests", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalVercel = process.env["VERCEL"];
  process.env["VERCEL"] = "1";
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network request");
  }) as typeof fetch;
  try {
    await import(`../app.js?dashboard-test=${Date.now()}`);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVercel === undefined) delete process.env["VERCEL"];
    else process.env["VERCEL"] = originalVercel;
  }
});

test("missing Anthropic key fails safely without a request", async () => {
  const originalKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "";
  const { createAnthropicClient, AnthropicConfigurationError } = await import("./anthropic.js");
  try {
    assert.throws(() => createAnthropicClient(), AnthropicConfigurationError);
  } finally {
    if (originalKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = originalKey;
  }
});

test("missing AI controls migration maps to a clear 503", () => {
  const error = Object.assign(new Error('relation "ai_request_usage" does not exist'), { code: "42P01" });
  assert.deepEqual(mapSamiaError(error, "claude-sonnet-5"), {
    status: 503,
    error: "Samia's database controls are not migrated. Run the database migration and retry.",
  });
});

test("Anthropic failures map to explicit HTTP responses", () => {
  assert.equal(mapSamiaError({ status: 401 }, "model").status, 502);
  assert.equal(mapSamiaError({ status: 403 }, "model").status, 502);
  assert.equal(mapSamiaError({ status: 402 }, "model").status, 402);
  assert.match(mapSamiaError({ status: 404 }, "missing-model").error, /missing-model/);
  assert.deepEqual(mapSamiaError({ status: 429 }, "model"), {
    status: 429,
    error: "Claude is temporarily rate-limited. Please retry shortly.",
    retryAfter: 60,
  });
  assert.equal(mapSamiaError({ status: 529 }, "model").status, 503);
  assert.equal(mapSamiaError({ name: "APIConnectionTimeoutError", message: "timed out" }, "model").status, 504);
});

test("Samia route invokes Claude only inside the authenticated chat handler", async () => {
  const source = await readFile(path.join(routesDir, "samia.ts"), "utf8");
  const routeStart = source.indexOf('router.post("/samia/chat", requireAuth, requireRole("admin")');
  assert.ok(routeStart > 0);
  const identityStart = source.indexOf("if (isModelIdentityQuestion(message))", routeStart);
  const limiterStart = source.indexOf("withDurableAiLimit", routeStart);
  assert.ok(identityStart > routeStart);
  assert.ok(limiterStart > identityStart);
  assert.ok(source.indexOf("createSamiaMessage", routeStart) > routeStart);
  assert.ok(source.indexOf("/api/samia/call-analysis?", routeStart) < source.indexOf("createSamiaMessage", routeStart));
  assert.match(source.slice(routeStart), /const activeCapabilityNames: SamiaCapabilityName\[\] = directCallId \|\| directPhone \|\| mode === "lightweight"/);
  assert.ok(source.indexOf("detectSamiaOperationalIntent(message)", routeStart) < limiterStart);
  assert.match(source.slice(routeStart), /isStaleModelIdentityMessage\(item\.role, item\.content\)/);
  assert.match(source, /safeStoredMessages\(rows\.reverse\(\)\)/);
  const systemPrompt = source.slice(source.indexOf("const SAMIA_SYSTEM"), source.indexOf("interface ChatMessage"));
  assert.doesNotMatch(systemPrompt, /analyze_calls|lookup_number/);
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
  assert.match(source, /evaluateCall\(callId/);
});

test("Live Transfer classification uses strict Anthropic tools and has no startup job", async () => {
  const source = await readFile(path.join(routesDir, "liveTransfers.ts"), "utf8");
  const indexSource = await readFile(path.join(routesDir, "index.ts"), "utf8");
  assert.match(source, /ANTHROPIC_LT_MODEL/);
  assert.match(source, /createAnthropicToolMessage/);
  assert.match(source, /record_live_transfer_classification/);
  assert.equal(indexSource.includes("startLiveTransfersBackground"), false);
});

async function runtimeSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await runtimeSourceFiles(resolved));
    else if (/\.(?:[cm]?js|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(resolved);
  }
  return files;
}

test("runtime sources contain no OpenAI or OpenRouter implementation", async () => {
  const roots = [path.resolve(routesDir, ".."), path.resolve(routesDir, "../../../../scripts/src")];
  for (const root of roots) {
    for (const file of await runtimeSourceFiles(root)) {
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(
        source,
        /@openai\/|from\s+["']openai|require\(["']openai|OPENAI_API_KEY|OPENROUTER_API_KEY|AI_INTEGRATIONS_OPENAI|AI_INTEGRATIONS_OPENROUTER|api\.openai\.com|openrouter\.ai/i,
        file,
      );
    }
  }
});

test("Samia diagnostics is admin-only and never returns a secret value", async () => {
  const source = await readFile(path.join(routesDir, "samia.ts"), "utf8");
  const start = source.indexOf('router.get("/samia/diagnostics"');
  const end = source.indexOf("});", start) + 3;
  const route = source.slice(start, end);
  assert.match(route, /requireAuth, requireRole\("admin"\)/);
  assert.match(route, /anthropicKeyExists: Boolean/);
  assert.match(route, /aiRequestUsageExists/);
  assert.doesNotMatch(route, /anthropicApiKey|apiKey:/i);
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
