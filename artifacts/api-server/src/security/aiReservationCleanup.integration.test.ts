import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import {
  aiReservationCleanupConfig,
  cleanupExpiredAiReservations,
} from "../lib/aiReservationCleanup.js";
import {
  hashAiIdempotencyKey,
  hashAiRequest,
  reserveIdempotentAiRequest,
} from "../lib/aiRequestReservations.js";

const configuredUrl = process.env["AI_RESERVATION_TEST_DATABASE_URL"]?.trim();
const activeUrl = process.env["DATABASE_URL"]?.trim();
const databaseName = configuredUrl ? new URL(configuredUrl).pathname.toLowerCase() : "";
const enabled = Boolean(
  process.env["NODE_ENV"] === "test" &&
  configuredUrl &&
  activeUrl === configuredUrl &&
  databaseName.includes("test"),
);
const feature = `cleanup_fixture_${process.pid}`;
const now = new Date("2026-08-12T09:00:00.000Z");

async function insert(
  key: string,
  status: "reserved" | "completed" | "failed",
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_request_reservations (
       feature, scope_key, idempotency_key, request_hash, status,
       completed_at, failed_at, expires_at
     ) VALUES (
       $1, 'synthetic-scope', $2, $3, $4,
       CASE WHEN $4 = 'completed' THEN $5::timestamptz ELSE NULL END,
       CASE WHEN $4 = 'failed' THEN $5::timestamptz ELSE NULL END,
       $5
     )`,
    [feature, hashAiIdempotencyKey(key), hashAiRequest({ key }), status, expiresAt],
  );
}

test("AI cleanup validates bounded configuration", () => {
  assert.deepEqual(aiReservationCleanupConfig({}), {
    retentionDays: 30,
    batchSize: 500,
    maxBatches: 4,
  });
  assert.throws(
    () => aiReservationCleanupConfig({ AI_RESERVATION_RETENTION_DAYS: "0" }),
    /AI_RESERVATION_RETENTION_DAYS_INVALID/,
  );
  assert.throws(
    () => aiReservationCleanupConfig({ AI_RESERVATION_CLEANUP_BATCH_SIZE: "5001" }),
    /AI_RESERVATION_CLEANUP_BATCH_SIZE_INVALID/,
  );
});

test("AI cleanup retains active and recent reservations and removes only old expired rows", { skip: !enabled }, async () => {
  await pool.query("DELETE FROM ai_request_reservations WHERE feature = $1", [feature]);
  try {
    await insert("active", "reserved", new Date("2026-08-12T10:00:00.000Z"));
    await insert("recent", "completed", new Date("2026-08-10T09:00:00.000Z"));
    await insert("old-completed", "completed", new Date("2026-07-01T09:00:00.000Z"));
    await insert("old-failed", "failed", new Date("2026-07-01T09:00:00.000Z"));

    const result = await cleanupExpiredAiReservations(
      { retentionDays: 7, batchSize: 10, maxBatches: 2 },
      pool,
      now,
    );
    assert.equal(result.rowsDeleted, 2);
    assert.equal(result.rowsExamined, 2);
    assert.ok(result.batches <= 2);
    const rows = await pool.query<{ status: string }>(
      "SELECT status FROM ai_request_reservations WHERE feature = $1 ORDER BY status",
      [feature],
    );
    assert.deepEqual(rows.rows.map((row) => row.status), ["completed", "reserved"]);
  } finally {
    await pool.query("DELETE FROM ai_request_reservations WHERE feature = $1", [feature]);
  }
});

test("AI cleanup is batch-bounded and safe under concurrent invocations", { skip: !enabled }, async () => {
  await pool.query("DELETE FROM ai_request_reservations WHERE feature = $1", [feature]);
  try {
    for (let index = 0; index < 5; index += 1) {
      await insert(`bounded-${index}`, "failed", new Date("2026-06-01T09:00:00.000Z"));
    }
    await insert("concurrent-active", "reserved", new Date("2026-08-12T10:00:00.000Z"));
    const bounded = await cleanupExpiredAiReservations(
      { retentionDays: 7, batchSize: 2, maxBatches: 1 },
      pool,
      now,
    );
    assert.equal(bounded.rowsDeleted, 2);
    assert.equal((await pool.query(
      "SELECT 1 FROM ai_request_reservations WHERE feature = $1",
      [feature],
    )).rowCount, 4);

    const concurrent = await Promise.all([
      cleanupExpiredAiReservations({ retentionDays: 7, batchSize: 2, maxBatches: 2 }, pool, now),
      cleanupExpiredAiReservations({ retentionDays: 7, batchSize: 2, maxBatches: 2 }, pool, now),
    ]);
    assert.equal(concurrent.reduce((total, result) => total + result.rowsDeleted, 0), 3);
    assert.equal((await pool.query(
      "SELECT 1 FROM ai_request_reservations WHERE feature = $1",
      [feature],
    )).rowCount, 1);
    assert.equal((await pool.query(
      "SELECT 1 FROM ai_request_reservations WHERE feature = $1 AND status = 'reserved'",
      [feature],
    )).rowCount, 1);
  } finally {
    await pool.query("DELETE FROM ai_request_reservations WHERE feature = $1", [feature]);
  }
});

test("an idempotency key is reusable only after legitimate expiry and retention cleanup", { skip: !enabled }, async () => {
  await pool.query("DELETE FROM ai_request_reservations WHERE feature = $1", [feature]);
  const rawKey = "reusable-after-retention";
  const idempotencyKey = hashAiIdempotencyKey(rawKey);
  try {
    await insert(rawKey, "failed", new Date("2026-06-01T09:00:00.000Z"));
    await cleanupExpiredAiReservations({ retentionDays: 7, batchSize: 10, maxBatches: 1 }, pool, now);
    const decision = await reserveIdempotentAiRequest({
      feature,
      scopeKey: "synthetic-scope",
      idempotencyKey,
      requestHash: hashAiRequest({ key: rawKey }),
      reservationSeconds: 60,
    });
    assert.equal(decision.kind, "reserved");
  } finally {
    await pool.query("DELETE FROM ai_request_reservations WHERE feature = $1", [feature]);
  }
});

test.after(async () => {
  if (enabled) await pool.end();
});
