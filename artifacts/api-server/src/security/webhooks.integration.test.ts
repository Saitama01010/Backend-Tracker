import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

const enabled = process.env["RUN_WEBHOOK_INTEGRATION_TEST"] === "1";

test("webhook HTTP delivery is durable and idempotent in PostgreSQL", { skip: !enabled }, async () => {
  const databaseUrl = process.env["DATABASE_URL"] ?? "";
  assert.match(databaseUrl, /test/i, "integration test requires an isolated test database URL");

  const secretBytes = Buffer.from("sanitized-runtime-signing-key-32-bytes");
  process.env["QUO_WEBHOOK_SECRET"] = secretBytes.toString("base64");
  process.env["QUO_API_KEY"] = "";
  process.env["ENABLE_BACKGROUND_JOBS"] = "false";

  const [{ default: app }, { pool }] = await Promise.all([
    import("../app.js"),
    import("@workspace/db"),
  ]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}/api/quo/webhook`;

  const sign = (body: Buffer, timestamp: number) => {
    const digest = crypto
      .createHmac("sha256", secretBytes)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("base64");
    return `hmac;1;${timestamp};${digest}`;
  };
  const post = (body: Buffer, signature: string) => fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "openphone-signature": signature,
    },
    body,
  });

  const eventId = "EV_INTEGRATION_COMPLETED_SANITIZED";
  const callId = "CALL_INTEGRATION_SANITIZED";
  const completedBody = Buffer.from(JSON.stringify({
    id: eventId,
    object: "event",
    apiVersion: "v2",
    createdAt: "2026-08-10T09:00:00.000Z",
    type: "call.completed",
    data: {
      object: {
        id: callId,
        object: "call",
        from: "sanitized-customer-reference",
        to: "sanitized-line-reference",
        direction: "incoming",
        status: "completed",
        createdAt: "2026-08-10T08:58:00.000Z",
        answeredAt: "2026-08-10T08:58:20.000Z",
        completedAt: "2026-08-10T09:00:00.000Z",
        userId: null,
        phoneNumberId: "LINE_INTEGRATION_SANITIZED",
      },
    },
  }));

  try {
    await pool.query("DELETE FROM webhook_inbox WHERE provider_event_id LIKE 'EV_INTEGRATION_%'");
    await pool.query("DELETE FROM phone_calls WHERE id LIKE 'CALL_INTEGRATION_%'");

    const firstTimestamp = Date.now();
    const first = await post(completedBody, sign(completedBody, firstTimestamp));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });

    const retryTimestamp = Date.now();
    const duplicate = await post(completedBody, sign(completedBody, retryTimestamp));
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { ok: true });

    const inboxResult = await pool.query<{ count: string; attempts: number; status: string }>(
      "SELECT count(*)::text AS count, max(attempts)::int AS attempts, max(status) AS status FROM webhook_inbox WHERE provider_event_id = $1",
      [eventId],
    );
    assert.deepEqual(inboxResult.rows[0], { count: "1", attempts: 1, status: "processed" });

    const kpiResult = await pool.query<{ total_calls: string; connected_calls: string; missed_calls: string }>(
      `SELECT count(*)::text AS total_calls,
              count(*) FILTER (WHERE status = 'completed')::text AS connected_calls,
              count(*) FILTER (WHERE status IN ('no-answer', 'missed'))::text AS missed_calls
         FROM phone_calls WHERE id = $1`,
      [callId],
    );
    assert.deepEqual(kpiResult.rows[0], {
      total_calls: "1",
      connected_calls: "1",
      missed_calls: "0",
    });

    const ringingBody = Buffer.from(JSON.stringify({
      id: "EV_INTEGRATION_LATE_RINGING_SANITIZED",
      type: "call.ringing",
      data: { object: { id: callId, userId: "USER_INTEGRATION_SANITIZED" } },
    }));
    const late = await post(ringingBody, sign(ringingBody, Date.now()));
    assert.equal(late.status, 200);

    const invalid = await post(completedBody, `hmac;1;${Date.now()};${Buffer.alloc(32).toString("base64")}`);
    assert.equal(invalid.status, 401);

    const modifiedBody = Buffer.from(completedBody.toString("utf8").replace("incoming", "outgoing"));
    const modified = await post(modifiedBody, sign(completedBody, Date.now()));
    assert.equal(modified.status, 401);

    const expiredTimestamp = Date.now() - 301_000;
    const expired = await post(completedBody, sign(completedBody, expiredTimestamp));
    assert.equal(expired.status, 401);

    await pool.query("DELETE FROM webhook_inbox WHERE provider_event_id LIKE 'EV_INTEGRATION_%'");
    await pool.query("DELETE FROM phone_calls WHERE id LIKE 'CALL_INTEGRATION_%'");

    // Closing the isolated pool simulates an unavailable database. The handler
    // must return a retryable response and must not run business processing.
    await pool.end();
    const databaseFailureBody = Buffer.from(JSON.stringify({
      id: "EV_INTEGRATION_DATABASE_FAILURE_SANITIZED",
      type: "message.delivered",
      data: { object: { id: "MESSAGE_INTEGRATION_SANITIZED" } },
    }));
    const databaseFailure = await post(databaseFailureBody, sign(databaseFailureBody, Date.now()));
    assert.equal(databaseFailure.status, 503);
    assert.equal(databaseFailure.headers.get("retry-after"), "5");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
