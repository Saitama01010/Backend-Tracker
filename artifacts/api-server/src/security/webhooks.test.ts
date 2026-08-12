import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  processDurableWebhook,
  type DurableWebhookStore,
  type WebhookClaimResult,
  type WebhookRecordResult,
  type WebhookTerminalStatus,
} from "../lib/durableWebhook.js";
import {
  durableWebhookPayload,
  parseOpenPhoneWebhook,
  verifyOpenPhoneSignature,
  type VerifiedWebhookEvent,
} from "../lib/openPhoneWebhook.js";

const secretBytes = Buffer.from("sanitized-openphone-test-signing-key-32-bytes");
const signingSecret = secretBytes.toString("base64");
const nowMs = 1_786_424_400_000;

function rawFixture(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    id: "EV_SANITIZED_COMPLETED_001",
    object: "event",
    apiVersion: "v2",
    createdAt: "2026-08-10T09:00:00.000Z",
    type: "call.completed",
    data: {
      object: {
        id: "CALL_SANITIZED_001",
        object: "call",
        from: "sanitized-customer-reference",
        to: "sanitized-line-reference",
        direction: "incoming",
        status: "completed",
        createdAt: "2026-08-10T08:58:00.000Z",
        answeredAt: "2026-08-10T08:58:20.000Z",
        completedAt: "2026-08-10T09:00:00.000Z",
        userId: "USER_SANITIZED_001",
        phoneNumberId: "LINE_SANITIZED_001",
      },
    },
    ...overrides,
  }), "utf8");
}

function signatureFor(rawBody: Buffer, timestamp = nowMs): string {
  const digest = crypto
    .createHmac("sha256", secretBytes)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]))
    .digest("base64");
  return `hmac;1;${timestamp};${digest}`;
}

interface FakeRow {
  payloadHash: string;
  status: "received" | "processing" | "processed" | "ignored" | "failed";
  attempts: number;
  lastErrorCode: string | null;
}

class FakeInbox implements DurableWebhookStore {
  readonly rows = new Map<string, FakeRow>();
  failFinishOnce = false;

  async record(event: VerifiedWebhookEvent): Promise<WebhookRecordResult> {
    const existing = this.rows.get(event.idempotencyKey);
    if (!existing) {
      this.rows.set(event.idempotencyKey, {
        payloadHash: event.payloadHash,
        status: "received",
        attempts: 0,
        lastErrorCode: null,
      });
      return "recorded";
    }
    return existing.payloadHash === event.payloadHash ? "known" : "collision";
  }

  async claim(idempotencyKey: string): Promise<WebhookClaimResult> {
    const row = this.rows.get(idempotencyKey);
    if (!row) throw new Error("fake_record_missing");
    if (row.status === "processed" || row.status === "ignored") return "terminal";
    if (row.status === "processing") return "busy";
    row.status = "processing";
    row.attempts += 1;
    row.lastErrorCode = null;
    return "claimed";
  }

  async finish(idempotencyKey: string, status: WebhookTerminalStatus): Promise<void> {
    if (this.failFinishOnce) {
      this.failFinishOnce = false;
      throw new Error("sanitized_database_failure");
    }
    const row = this.rows.get(idempotencyKey);
    if (!row) throw new Error("fake_record_missing");
    row.status = status;
  }

  async fail(idempotencyKey: string, errorCode: string): Promise<void> {
    const row = this.rows.get(idempotencyKey);
    if (!row) throw new Error("fake_record_missing");
    row.status = "failed";
    row.lastErrorCode = errorCode;
  }
}

test("valid signatures cover the exact raw request bytes", () => {
  const raw = Buffer.from('{\n  "id": "EV_SANITIZED_RAW",\n  "type": "call.completed"\n}', "utf8");
  assert.deepEqual(
    verifyOpenPhoneSignature(raw, signatureFor(raw), signingSecret, { nowMs }),
    { valid: true, timestamp: nowMs },
  );

  const sameJsonDifferentBytes = Buffer.from('{"id":"EV_SANITIZED_RAW","type":"call.completed"}', "utf8");
  assert.deepEqual(
    verifyOpenPhoneSignature(sameJsonDifferentBytes, signatureFor(raw), signingSecret, { nowMs }),
    { valid: false, reason: "mismatch" },
  );
});

test("invalid, modified, expired, future, and unsupported signatures are rejected", () => {
  const raw = rawFixture();
  const modified = Buffer.from(raw.toString("utf8").replace("incoming", "outgoing"), "utf8");
  assert.equal(verifyOpenPhoneSignature(raw, undefined, signingSecret, { nowMs }).valid, false);
  assert.equal(verifyOpenPhoneSignature(raw, "hmac;1;bad;signature", signingSecret, { nowMs }).valid, false);
  assert.deepEqual(
    verifyOpenPhoneSignature(modified, signatureFor(raw), signingSecret, { nowMs }),
    { valid: false, reason: "mismatch" },
  );
  assert.deepEqual(
    verifyOpenPhoneSignature(raw, signatureFor(raw, nowMs - 301_000), signingSecret, { nowMs }),
    { valid: false, reason: "expired" },
  );
  assert.deepEqual(
    verifyOpenPhoneSignature(raw, signatureFor(raw, nowMs + 301_000), signingSecret, { nowMs }),
    { valid: false, reason: "expired" },
  );
  assert.equal(
    verifyOpenPhoneSignature(raw, signatureFor(raw).replace("hmac;1;", "hmac;2;"), signingSecret, { nowMs }).valid,
    false,
  );
});

test("provider event IDs are stable idempotency keys across provider retry timestamps", () => {
  const raw = rawFixture();
  const first = verifyOpenPhoneSignature(raw, signatureFor(raw, nowMs - 1_000), signingSecret, { nowMs });
  const retry = verifyOpenPhoneSignature(raw, signatureFor(raw, nowMs + 1_000), signingSecret, { nowMs });
  assert.equal(first.valid, true);
  assert.equal(retry.valid, true);
  const parsed = parseOpenPhoneWebhook(raw);
  assert.equal(parsed.providerEventId, "EV_SANITIZED_COMPLETED_001");
  assert.equal(parsed.idempotencyKey, "openphone:EV_SANITIZED_COMPLETED_001");
  assert.equal(parsed.objectId, "CALL_SANITIZED_001");
});

test("semantic payload hashes are stable across harmless JSON serialization differences", () => {
  const compact = Buffer.from('{"id":"EV_SANITIZED_HASH","type":"call.completed","data":{"object":{"id":"CALL_SANITIZED_HASH"}}}');
  const spaced = Buffer.from('{\n "data": { "object": { "id": "CALL_SANITIZED_HASH" } },\n "type": "call.completed",\n "id": "EV_SANITIZED_HASH"\n}');
  assert.equal(parseOpenPhoneWebhook(compact).payloadHash, parseOpenPhoneWebhook(spaced).payloadHash);
});

test("ignored transcript and message payloads are minimized before durable storage", () => {
  const transcript = parseOpenPhoneWebhook(rawFixture({
    id: "EV_SANITIZED_TRANSCRIPT",
    type: "call.transcript.completed",
    data: {
      object: {
        callId: "CALL_SANITIZED_TRANSCRIPT",
        dialogue: [{ content: "sanitized transcript content", identifier: "sanitized-customer-reference" }],
      },
    },
  }));
  assert.deepEqual(durableWebhookPayload(transcript), {
    id: "EV_SANITIZED_TRANSCRIPT",
    object: "event",
    apiVersion: "v2",
    createdAt: "2026-08-10T09:00:00.000Z",
    type: "call.transcript.completed",
    data: { object: { id: "CALL_SANITIZED_TRANSCRIPT" } },
  });
});

test("duplicate delivery processes once and preserves final dashboard totals", async () => {
  const event = parseOpenPhoneWebhook(rawFixture());
  const inbox = new FakeInbox();
  const calls = new Map<string, { connected: number; missed: number }>();
  let processorRuns = 0;
  const processor = async (delivery: VerifiedWebhookEvent): Promise<WebhookTerminalStatus> => {
    processorRuns += 1;
    calls.set(delivery.objectId!, { connected: 1, missed: 0 });
    return "processed";
  };

  assert.equal(await processDurableWebhook(event, inbox, processor), "processed");
  assert.equal(await processDurableWebhook(event, inbox, processor), "duplicate");
  assert.equal(await processDurableWebhook(event, inbox, processor), "duplicate");
  assert.equal(processorRuns, 1);
  assert.deepEqual(
    [...calls.values()].reduce(
      (totals, call) => ({
        totalCalls: totals.totalCalls + 1,
        connectedCalls: totals.connectedCalls + call.connected,
        missedCalls: totals.missedCalls + call.missed,
      }),
      { totalCalls: 0, connectedCalls: 0, missedCalls: 0 },
    ),
    { totalCalls: 1, connectedCalls: 1, missedCalls: 0 },
  );
});

test("event ID collisions and concurrent processing do not run business logic", async () => {
  const original = parseOpenPhoneWebhook(rawFixture());
  const changed = parseOpenPhoneWebhook(rawFixture({ createdAt: "2026-08-10T09:00:01.000Z" }));
  const inbox = new FakeInbox();
  let processorRuns = 0;
  const processor = async (): Promise<WebhookTerminalStatus> => {
    processorRuns += 1;
    return "processed";
  };

  assert.equal(await processDurableWebhook(original, inbox, processor), "processed");
  assert.equal(await processDurableWebhook(changed, inbox, processor), "collision");
  assert.equal(processorRuns, 1);

  const busyEvent = parseOpenPhoneWebhook(rawFixture({ id: "EV_SANITIZED_BUSY" }));
  await inbox.record(busyEvent);
  inbox.rows.get(busyEvent.idempotencyKey)!.status = "processing";
  assert.equal(await processDurableWebhook(busyEvent, inbox, processor), "busy");
  assert.equal(processorRuns, 1);
});

test("provider retry recovers after a partial failure without duplicating the call", async () => {
  const event = parseOpenPhoneWebhook(rawFixture());
  const inbox = new FakeInbox();
  const calls = new Map<string, { status: string }>();
  inbox.failFinishOnce = true;
  const processor = async (delivery: VerifiedWebhookEvent): Promise<WebhookTerminalStatus> => {
    // Mirrors the production phone_calls primary-key upsert: repeating this
    // write replaces the same call rather than adding a second KPI row.
    calls.set(delivery.objectId!, { status: "completed" });
    return "processed";
  };

  await assert.rejects(() => processDurableWebhook(event, inbox, processor), /sanitized_database_failure/);
  assert.equal(inbox.rows.get(event.idempotencyKey)?.status, "failed");
  assert.equal(await processDurableWebhook(event, inbox, processor), "processed");
  assert.equal(inbox.rows.get(event.idempotencyKey)?.attempts, 2);
  assert.equal(calls.size, 1);
});

test("database receipt failure returns control before business processing", async () => {
  const event = parseOpenPhoneWebhook(rawFixture());
  let processorRuns = 0;
  const failingStore: DurableWebhookStore = {
    async record() { throw new Error("sanitized_database_unavailable"); },
    async claim() { return "claimed"; },
    async finish() {},
    async fail() {},
  };
  await assert.rejects(
    () => processDurableWebhook(event, failingStore, async () => {
      processorRuns += 1;
      return "processed";
    }),
    /sanitized_database_unavailable/,
  );
  assert.equal(processorRuns, 0);
});

test("out-of-order live events are checked against a durable completed event", async () => {
  const routeSource = await readFile(new URL("../routes/quoWebhook.ts", import.meta.url), "utf8");
  assert.match(routeSource, /await hasProcessedCallCompletion\(call\.id\)/);
  assert.match(routeSource, /ignored late live-call event/);
  assert.match(routeSource, /liveWebhookCalls\.delete\(call\.id\)/);
});

test("webhook endpoints use raw parsing, retryable failures, sanitized logs, and an additive inbox migration", async () => {
  const [appSource, routeSource, migration] = await Promise.all([
    readFile(new URL("../app.ts", import.meta.url), "utf8"),
    readFile(new URL("../routes/quoWebhook.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../../lib/db/drizzle/0006_webhook_inbox.sql", import.meta.url), "utf8"),
  ]);

  const rawParserAt = appSource.indexOf("express.raw");
  const jsonParserAt = appSource.indexOf("app.use(express.json(");
  assert.ok(rawParserAt >= 0 && rawParserAt < jsonParserAt);
  assert.doesNotMatch(routeSource, /JSON\.stringify\(req\.body\)/);
  assert.match(routeSource, /status\(401\)/);
  assert.match(routeSource, /status\(503\)/);
  assert.match(routeSource, /Retry-After/);
  assert.doesNotMatch(routeSource, /logger\.(?:info|warn|error)\([^\n]*(?:openphone-signature|req\.body|webhookSecret\(\))/);
  assert.doesNotMatch(routeSource, /logger\.(?:info|warn|error)\([^\n]*participant/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "webhook_inbox"/);
  assert.match(migration, /PRIMARY KEY/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "webhook_inbox_provider_event_uidx"/);
  assert.match(migration, /"status" text DEFAULT 'received'/);
  assert.match(migration, /"last_error_code" text/);
  assert.match(migration, /CONSTRAINT "webhook_inbox_status_check" CHECK/);
});
