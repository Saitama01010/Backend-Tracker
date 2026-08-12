import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { pool as workspacePool } from "@workspace/db";

type QueryValue = string | number | Date | null;
type QueryClient = Pick<PoolClient, "release"> & {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: QueryValue[],
  ): Promise<QueryResult<T>>;
};
type ConnectionPool = Pick<Pool, "connect">;

interface ReservationRow extends Record<string, unknown> {
  id: number;
  request_hash: string;
  status: "reserved" | "completed" | "failed";
  response_status: number | null;
  response_body: Record<string, unknown> | null;
  reserved_at: Date;
  completed_at: Date | null;
  expires_at: Date;
  active: boolean;
}

export interface AiReservationInput {
  feature: string;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  reservationSeconds: number;
}

export type AiReservationDecision =
  | { kind: "reserved"; id: number }
  | {
      kind: "completed";
      id: number;
      responseStatus: number;
      responseBody: Record<string, unknown>;
    }
  | { kind: "in_progress"; id: number; retryAfter: number }
  | { kind: "conflict"; id: number };

export interface QaReservationInput {
  agentKey: string;
  agentName: string;
  callId: string;
  idempotencyKey: string;
  requestHash: string;
  source: "auto_biweekly" | "manual_call_id";
  requestedByUserId: number | null;
  reservationSeconds?: number;
}

export type QaReservationDecision =
  | { kind: "reserved"; id: number }
  | { kind: "completed"; id: number }
  | { kind: "in_progress"; id: number; retryAfter: number }
  | { kind: "cooldown"; eligibleAt: Date }
  | { kind: "conflict"; id: number };

const QA_FEATURE = "qa_agent";
const QA_INTERVAL_MS = 14 * 24 * 60 * 60 * 1_000;

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") return "null";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function hashAiRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashAiIdempotencyKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeQaAgentKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function boundedSeconds(
  value: number,
  fallback: number,
  maximum: number,
): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.trunc(value)))
    : fallback;
}

function retryAfter(row: ReservationRow, now = Date.now()): number {
  return Math.max(
    1,
    Math.ceil((new Date(row.expires_at).getTime() - now) / 1_000),
  );
}

async function begin(client: QueryClient): Promise<void> {
  await client.query("BEGIN");
}

async function rollback(client: QueryClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

async function commit(client: QueryClient): Promise<void> {
  await client.query("COMMIT");
}

async function currentReservation(
  client: QueryClient,
  feature: string,
  scopeKey: string,
  idempotencyKey: string,
): Promise<ReservationRow | null> {
  const result = await client.query<ReservationRow>(
    `SELECT id, request_hash, status, response_status, response_body,
            reserved_at, completed_at, expires_at, expires_at > now() AS active
       FROM ai_request_reservations
      WHERE feature = $1 AND scope_key = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [feature, scopeKey, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function insertReservation(
  client: QueryClient,
  input: AiReservationInput,
): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO ai_request_reservations (
       feature, scope_key, idempotency_key, request_hash, status, expires_at
     ) VALUES ($1, $2, $3, $4, 'reserved', now() + make_interval(secs => $5))
     RETURNING id`,
    [
      input.feature,
      input.scopeKey,
      input.idempotencyKey,
      input.requestHash,
      boundedSeconds(input.reservationSeconds, 120, 3_600),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("AI reservation was not created");
  return id;
}

async function resetReservation(
  client: QueryClient,
  id: number,
  requestHash: string,
  reservationSeconds: number,
): Promise<void> {
  await client.query(
    `UPDATE ai_request_reservations
        SET request_hash = $2, status = 'reserved', response_status = NULL,
            response_body = NULL, failure_code = NULL, reserved_at = now(),
            completed_at = NULL, failed_at = NULL,
            expires_at = now() + make_interval(secs => $3)
      WHERE id = $1`,
    [id, requestHash, boundedSeconds(reservationSeconds, 120, 3_600)],
  );
}

export async function reserveIdempotentAiRequest(
  input: AiReservationInput,
  connectionPool: ConnectionPool = workspacePool,
): Promise<AiReservationDecision> {
  const client = (await connectionPool.connect()) as QueryClient;
  try {
    await begin(client);
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `ai-request:${input.feature}:${input.scopeKey}:${input.idempotencyKey}`,
      ]);
      const existing = await currentReservation(
        client,
        input.feature,
        input.scopeKey,
        input.idempotencyKey,
      );
      if (existing && existing.request_hash !== input.requestHash) {
        await commit(client);
        return { kind: "conflict", id: existing.id };
      }
      if (existing?.status === "completed" && existing.active) {
        await commit(client);
        return {
          kind: "completed",
          id: existing.id,
          responseStatus: existing.response_status ?? 200,
          responseBody: existing.response_body ?? {},
        };
      }
      if (existing?.status === "reserved" && existing.active) {
        await commit(client);
        return {
          kind: "in_progress",
          id: existing.id,
          retryAfter: retryAfter(existing),
        };
      }
      if (existing) {
        await resetReservation(
          client,
          existing.id,
          input.requestHash,
          input.reservationSeconds,
        );
        await commit(client);
        return { kind: "reserved", id: existing.id };
      }
      const id = await insertReservation(client, input);
      await commit(client);
      return { kind: "reserved", id };
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function reserveQaAgentRun(
  input: QaReservationInput,
  connectionPool: ConnectionPool = workspacePool,
): Promise<QaReservationDecision> {
  const client = (await connectionPool.connect()) as QueryClient;
  const reservationSeconds = boundedSeconds(
    input.reservationSeconds ?? 600,
    600,
    3_600,
  );
  try {
    await begin(client);
    try {
      // Every automatic and ordinary manual request for the same authoritative
      // agent identity serializes on this database-owned transaction lock.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `qa-agent:${input.agentKey}`,
      ]);
      const existing = await currentReservation(
        client,
        QA_FEATURE,
        input.agentKey,
        input.idempotencyKey,
      );
      if (existing && existing.request_hash !== input.requestHash) {
        await commit(client);
        return { kind: "conflict", id: existing.id };
      }
      if (existing?.status === "completed" && existing.active) {
        await commit(client);
        return { kind: "completed", id: existing.id };
      }
      if (existing?.status === "reserved" && existing.active) {
        await commit(client);
        return {
          kind: "in_progress",
          id: existing.id,
          retryAfter: retryAfter(existing),
        };
      }

      const timeResult = await client.query<{ database_now: Date }>(
        "SELECT now() AS database_now",
      );
      const databaseNow = new Date(
        timeResult.rows[0]?.database_now ?? new Date(),
      );
      const cutoff = new Date(databaseNow.getTime() - QA_INTERVAL_MS);
      const recentReviews = await client.query<{
        agent_name: string;
        evaluated_at: Date;
      }>(
        `SELECT agent_name, evaluated_at
           FROM qa_reviews
          WHERE evaluated_at > $1
          ORDER BY evaluated_at DESC`,
        [cutoff],
      );
      const priorReview = recentReviews.rows.find(
        (row) => normalizeQaAgentKey(row.agent_name) === input.agentKey,
      );

      const activeRuns = await client.query<ReservationRow>(
        `SELECT id, request_hash, status, response_status, response_body,
                reserved_at, completed_at, expires_at, expires_at > now() AS active
           FROM ai_request_reservations
          WHERE feature = $1 AND scope_key = $2 AND id <> coalesce($3, -1)
            AND ((status = 'completed' AND completed_at > $4)
              OR (status = 'reserved' AND expires_at > now()))
          ORDER BY coalesce(completed_at, reserved_at) DESC
          LIMIT 1
          FOR UPDATE`,
        [QA_FEATURE, input.agentKey, existing?.id ?? null, cutoff],
      );
      const activeRun = activeRuns.rows[0];
      if (activeRun?.status === "reserved") {
        await commit(client);
        return {
          kind: "in_progress",
          id: activeRun.id,
          retryAfter: retryAfter(activeRun),
        };
      }

      const reviewEligibleAt = priorReview
        ? new Date(
            new Date(priorReview.evaluated_at).getTime() + QA_INTERVAL_MS,
          )
        : null;
      const runEligibleAt = activeRun?.completed_at
        ? new Date(new Date(activeRun.completed_at).getTime() + QA_INTERVAL_MS)
        : null;
      const eligibleAt = [reviewEligibleAt, runEligibleAt]
        .filter((value): value is Date => value !== null)
        .sort((left, right) => right.getTime() - left.getTime())[0];
      if (eligibleAt && eligibleAt.getTime() > databaseNow.getTime()) {
        await commit(client);
        return { kind: "cooldown", eligibleAt };
      }

      const requestInput: AiReservationInput = {
        feature: QA_FEATURE,
        scopeKey: input.agentKey,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        reservationSeconds,
      };
      const id = existing
        ? (await resetReservation(
            client,
            existing.id,
            input.requestHash,
            reservationSeconds,
          ),
          existing.id)
        : await insertReservation(client, requestInput);
      await client.query(
        `UPDATE ai_request_reservations
            SET response_body = jsonb_build_object(
              'agentName', $2::text,
              'callId', $3::text,
              'source', $4::text,
              'requestedByUserId', $5::integer
            )
          WHERE id = $1`,
        [
          id,
          input.agentName,
          input.callId,
          input.source,
          input.requestedByUserId,
        ],
      );
      await commit(client);
      return { kind: "reserved", id };
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function completeAiReservation(
  id: number,
  responseStatus: number,
  responseBody: Record<string, unknown>,
  reuseSeconds: number,
  connectionPool: Pick<Pool, "query"> = workspacePool,
): Promise<void> {
  const result = await connectionPool.query(
    `UPDATE ai_request_reservations
        SET status = 'completed', response_status = $2, response_body = $3,
            completed_at = now(), failed_at = NULL, failure_code = NULL,
            expires_at = now() + make_interval(secs => $4)
      WHERE id = $1 AND status = 'reserved'`,
    [
      id,
      responseStatus,
      responseBody,
      boundedSeconds(reuseSeconds, 86_400, 30 * 24 * 60 * 60),
    ],
  );
  if (result.rowCount !== 1)
    throw new Error("AI reservation could not be completed");
}

export async function failAiReservation(
  id: number,
  failureCode: string,
  connectionPool: Pick<Pool, "query"> = workspacePool,
): Promise<void> {
  await connectionPool.query(
    `UPDATE ai_request_reservations
        SET status = 'failed', response_status = NULL, response_body = NULL,
            failure_code = $2, failed_at = now(), expires_at = now()
      WHERE id = $1 AND status = 'reserved'`,
    [id, failureCode.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 80)],
  );
}

export const QA_ROLLING_INTERVAL_DAYS = 14;
