import { db, phoneCallsTable, pool } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import {
  upsertQuoPhoneCallRows,
  type QuoPhoneCallRow,
} from "../../integrations/quo/sync.js";
import {
  deleteDurableRuntimeState,
  getDurableRuntimeState,
  getDurableRuntimeStateIncludingExpired,
  listDurableRuntimeState,
  putDurableRuntimeState,
} from "../../lib/durableRuntimeState.js";
import type { AuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import { retentionRepository } from "./retention.repository.js";

export interface RetentionQuoDurableEntry<T> {
  value: T;
  updatedAt: Date;
  expiresAt: Date | null;
}

export interface RetentionQuoLiveDatabaseRow {
  agentName: string | null;
  participant: string;
  syncedAt: Date;
}

export type RetentionQuoLivePollSnapshot = Record<string, unknown> & {
  active: string[];
  agentCalls: Array<{ agentName: string; participant: string }>;
  sourceTimestamp?: string;
};

export type RetentionQuoDurableWebhookCall = Record<string, unknown> & {
  agentName: string;
  participant: string;
  ringingSince: string;
};

export type RetentionQuoDurableWebhookEnd = Record<string, unknown> & {
  agentName: string;
  sourceTimestamp: string;
};

export type RetentionQuoWebhookObservation = Record<string, unknown> & {
  sourceTimestamp: string;
};

export interface RetentionQuoLiveRepository {
  tryAcquirePollLease(key: string, owner: string, leaseMs: number): Promise<boolean>;
  releasePollLease(key: string, owner: string): Promise<void>;
  loadFreshPollState(key: string): Promise<RetentionQuoDurableEntry<RetentionQuoLivePollSnapshot> | null>;
  loadPollState(key: string): Promise<RetentionQuoDurableEntry<RetentionQuoLivePollSnapshot> | null>;
  publishPollState(key: string, snapshot: RetentionQuoLivePollSnapshot, ttlMs: number): Promise<void>;
  loadDurableWebhookCalls(prefix: string): Promise<Array<RetentionQuoDurableEntry<RetentionQuoDurableWebhookCall>>>;
  loadDurableWebhookEnds(prefix: string): Promise<Array<RetentionQuoDurableEntry<RetentionQuoDurableWebhookEnd>>>;
  loadWebhookObservation(key: string): Promise<RetentionQuoDurableEntry<RetentionQuoWebhookObservation> | null>;
  loadInProgressRows(since: Date): Promise<RetentionQuoLiveDatabaseRow[]>;
  persistCompletedCalls(rows: QuoPhoneCallRow[], signal?: AbortSignal): Promise<{ inserted: number; errors: number }>;
  deleteDurableWebhookCall(callId: string): Promise<void>;
  loadAuthorizationAgentDirectory(): Promise<AuthorizationAgentDirectory>;
}

export const retentionQuoLiveRepository: RetentionQuoLiveRepository = {
  async tryAcquirePollLease(key, owner, leaseMs) {
    const result = await pool.query<{ owner: string }>(
      `INSERT INTO durable_runtime_state (key, value, updated_at, expires_at)
       VALUES ($1, jsonb_build_object('owner', $2::text), now(), now() + ($3::bigint * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at,
             expires_at = EXCLUDED.expires_at
         WHERE durable_runtime_state.expires_at IS NULL
            OR durable_runtime_state.expires_at <= now()
       RETURNING value->>'owner' AS owner`,
      [key, owner, leaseMs],
    );
    return result.rows[0]?.owner === owner;
  },
  async releasePollLease(key, owner) {
    await pool.query(
      `DELETE FROM durable_runtime_state
       WHERE key = $1 AND value->>'owner' = $2`,
      [key, owner],
    );
  },
  loadFreshPollState: (key) => getDurableRuntimeState<RetentionQuoLivePollSnapshot>(key),
  loadPollState: (key) => getDurableRuntimeStateIncludingExpired<RetentionQuoLivePollSnapshot>(key),
  async publishPollState(key, snapshot, ttlMs) {
    await putDurableRuntimeState(key, snapshot, ttlMs);
  },
  async loadDurableWebhookCalls(prefix) {
    return listDurableRuntimeState<RetentionQuoDurableWebhookCall>(prefix);
  },
  async loadDurableWebhookEnds(prefix) {
    return listDurableRuntimeState<RetentionQuoDurableWebhookEnd>(prefix);
  },
  loadWebhookObservation: (key) => getDurableRuntimeStateIncludingExpired<RetentionQuoWebhookObservation>(key),
  async loadInProgressRows(since) {
    return db.select({
      agentName: phoneCallsTable.agentName,
      participant: phoneCallsTable.participant,
      syncedAt: phoneCallsTable.syncedAt,
    })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.syncedAt, since), eq(phoneCallsTable.status, "in-progress")));
  },
  persistCompletedCalls: (rows, signal) => upsertQuoPhoneCallRows(rows, signal),
  deleteDurableWebhookCall: (callId) => deleteDurableRuntimeState(`quo:webhook-live:${callId}`),
  loadAuthorizationAgentDirectory: () => retentionRepository.loadAuthorizationAgentDirectory(),
};
