import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import {
  completeAiReservation,
  failAiReservation,
  hashAiIdempotencyKey,
  hashAiRequest,
  normalizeQaAgentKey,
  reserveQaAgentRun,
} from "../lib/aiRequestReservations.js";

const configuredUrl = process.env["AI_RESERVATION_TEST_DATABASE_URL"]?.trim();
const activeUrl = process.env["DATABASE_URL"]?.trim();
const databaseName = configuredUrl
  ? new URL(configuredUrl).pathname.toLowerCase()
  : "";
const enabled = Boolean(
  process.env["NODE_ENV"] === "test" &&
  configuredUrl &&
  activeUrl === configuredUrl &&
  databaseName.includes("test"),
);

test(
  "PostgreSQL serializes QA reservations per agent across automatic and manual requests",
  {
    skip: enabled
      ? false
      : "DATABASE_URL and AI_RESERVATION_TEST_DATABASE_URL must match an isolated test database",
  },
  async () => {
    const agentName = "Fixture Reservation Agent";
    const otherAgentName = "Fixture Independent Agent";
    const agentKey = normalizeQaAgentKey(agentName);
    const otherAgentKey = normalizeQaAgentKey(otherAgentName);
    const reserve = (
      callId: string,
      source: "auto_biweekly" | "manual_call_id",
      key = agentKey,
      name = agentName,
    ) =>
      reserveQaAgentRun({
        agentKey: key,
        agentName: name,
        callId,
        idempotencyKey: hashAiIdempotencyKey(`integration:${callId}`),
        requestHash: hashAiRequest({ callId }),
        source,
        requestedByUserId: source === "manual_call_id" ? 7001 : null,
        reservationSeconds: 60,
      });

    await pool.query(
      "DELETE FROM ai_request_reservations WHERE feature = 'qa_agent' AND scope_key = ANY($1::text[])",
      [[agentKey, otherAgentKey]],
    );

    try {
      const concurrent = await Promise.all([
        reserve("CALL_RESERVATION_AUTOMATIC_001", "auto_biweekly"),
        reserve("CALL_RESERVATION_MANUAL_002", "manual_call_id"),
      ]);
      assert.equal(
        concurrent.filter((decision) => decision.kind === "reserved").length,
        1,
      );
      assert.equal(
        concurrent.filter((decision) => decision.kind === "in_progress").length,
        1,
      );

      const active = concurrent.find(
        (decision) => decision.kind === "reserved",
      );
      assert.ok(active && active.kind === "reserved");
      await failAiReservation(active.id, "INTEGRATION_RETRY");

      const retried = await reserve(
        "CALL_RESERVATION_MANUAL_002",
        "manual_call_id",
      );
      assert.equal(retried.kind, "reserved");
      assert.ok(retried.kind === "reserved");
      await completeAiReservation(
        retried.id,
        200,
        { callId: "CALL_RESERVATION_MANUAL_002" },
        14 * 24 * 60 * 60,
      );

      const blocked = await reserve(
        "CALL_RESERVATION_MANUAL_003",
        "manual_call_id",
      );
      assert.equal(blocked.kind, "cooldown");

      const independent = await reserve(
        "CALL_RESERVATION_OTHER_004",
        "auto_biweekly",
        otherAgentKey,
        otherAgentName,
      );
      assert.equal(independent.kind, "reserved");
      if (independent.kind === "reserved")
        await failAiReservation(independent.id, "INTEGRATION_CLEANUP");
    } finally {
      await pool.query(
        "DELETE FROM ai_request_reservations WHERE feature = 'qa_agent' AND scope_key = ANY($1::text[])",
        [[agentKey, otherAgentKey]],
      );
    }
  },
);
