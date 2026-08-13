import assert from "node:assert/strict";
import test from "node:test";
import { fetchQuoTranscript } from "./transcripts.js";

interface DialogueLine {
  identifier?: string;
  content?: string;
}

interface TranscriptBody {
  data?: { dialogue?: DialogueLine[]; status?: string };
}

type TranscriptResult =
  | { kind: "ok"; dialogue: DialogueLine[]; status: string }
  | { kind: "notfound" }
  | { kind: "error" };

/**
 * Characterization oracle copied from the two route-local implementations
 * before consolidation. Keep this local so the test compares the extracted
 * integration against the old observable behavior instead of reusing its code.
 */
async function legacyTranscriptResult(response: Response): Promise<TranscriptResult> {
  if (response.status === 404) return { kind: "notfound" };
  if (response.status === 429 || response.status >= 500) return { kind: "error" };
  if (!response.ok) return { kind: "error" };
  const body = (await response.json()) as TranscriptBody;
  return {
    kind: "ok",
    dialogue: body?.data?.dialogue ?? [],
    status: body?.data?.status ?? "none",
  };
}

test("the duplicated onboarding and live-transfer transcript contract is characterized", async () => {
  const cases = [
    () => new Response(JSON.stringify({ data: { dialogue: [{ identifier: "agent", content: "hello" }], status: "completed" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    () => new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503 }),
  ];

  assert.deepEqual(await legacyTranscriptResult(cases[0]!()), {
    kind: "ok",
    dialogue: [{ identifier: "agent", content: "hello" }],
    status: "completed",
  });
  assert.deepEqual(await legacyTranscriptResult(cases[1]!()), {
    kind: "ok",
    dialogue: [],
    status: "none",
  });
  assert.deepEqual(await legacyTranscriptResult(cases[2]!()), { kind: "notfound" });
  assert.deepEqual(await legacyTranscriptResult(cases[3]!()), { kind: "error" });
  assert.deepEqual(await legacyTranscriptResult(cases[4]!()), { kind: "error" });
  assert.deepEqual(await legacyTranscriptResult(cases[5]!()), { kind: "error" });

  for (const response of cases) {
    const expected = await legacyTranscriptResult(response());
    const actual = await fetchQuoTranscript("call-characterization", {
      apiKey: "sanitized-key",
      attempts: 1,
      fetchImpl: async () => response(),
      sleep: async () => undefined,
    });
    assert.deepEqual(actual, expected);
  }
});

test("the shared transcript client preserves retry timing, request headers, and terminal success", async () => {
  const delays: number[] = [];
  const requests: Array<{ url: string; authorization: string | null; accept: string | null }> = [];
  const responses = [
    new Response(null, { status: 429 }),
    new Response(null, { status: 503 }),
    new Response(JSON.stringify({ data: { dialogue: [], status: "completed" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];

  const result = await fetchQuoTranscript("call-retry", {
    apiKey: "sanitized-key",
    attempts: 3,
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        accept: headers.get("accept"),
      });
      return responses.shift()!;
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  assert.deepEqual(result, { kind: "ok", dialogue: [], status: "completed" });
  assert.deepEqual(delays, [2_000, 4_000]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], {
    url: "https://api.openphone.com/v1/call-transcripts/call-retry",
    authorization: "sanitized-key",
    accept: "application/json",
  });
});
