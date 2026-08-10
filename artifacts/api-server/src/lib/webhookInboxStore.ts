import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db, webhookInboxTable } from "@workspace/db";
import type {
  DurableWebhookStore,
  WebhookClaimResult,
  WebhookRecordResult,
  WebhookTerminalStatus,
} from "./durableWebhook.js";
import { durableWebhookPayload, type VerifiedWebhookEvent } from "./openPhoneWebhook.js";

const PROCESSING_LEASE_MS = 30_000;

export const openPhoneWebhookInbox: DurableWebhookStore = {
  async record(event: VerifiedWebhookEvent): Promise<WebhookRecordResult> {
    const now = new Date();
    const inserted = await db
      .insert(webhookInboxTable)
      .values({
        idempotencyKey: event.idempotencyKey,
        provider: event.provider,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        objectId: event.objectId,
        payloadHash: event.payloadHash,
        payload: durableWebhookPayload(event),
        firstReceivedAt: now,
        lastReceivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ payloadHash: webhookInboxTable.payloadHash });

    if (inserted.length > 0) return "recorded";

    const [existing] = await db
      .select({ payloadHash: webhookInboxTable.payloadHash })
      .from(webhookInboxTable)
      .where(eq(webhookInboxTable.idempotencyKey, event.idempotencyKey))
      .limit(1);
    if (!existing) throw new Error("webhook_inbox_conflict_unresolved");
    if (existing.payloadHash !== event.payloadHash) return "collision";

    await db
      .update(webhookInboxTable)
      .set({ lastReceivedAt: now })
      .where(eq(webhookInboxTable.idempotencyKey, event.idempotencyKey));
    return "known";
  },

  async claim(idempotencyKey: string): Promise<WebhookClaimResult> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const claimed = await db
      .update(webhookInboxTable)
      .set({
        status: "processing",
        attempts: sql`${webhookInboxTable.attempts} + 1`,
        processingStartedAt: now,
        processedAt: null,
        lastErrorCode: null,
      })
      .where(and(
        eq(webhookInboxTable.idempotencyKey, idempotencyKey),
        or(
          inArray(webhookInboxTable.status, ["received", "failed"]),
          and(
            eq(webhookInboxTable.status, "processing"),
            lt(webhookInboxTable.processingStartedAt, staleBefore),
          ),
        ),
      ))
      .returning({ idempotencyKey: webhookInboxTable.idempotencyKey });
    if (claimed.length > 0) return "claimed";

    const [existing] = await db
      .select({ status: webhookInboxTable.status })
      .from(webhookInboxTable)
      .where(eq(webhookInboxTable.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!existing) throw new Error("webhook_inbox_record_missing");
    return existing.status === "processed" || existing.status === "ignored" ? "terminal" : "busy";
  },

  async finish(idempotencyKey: string, status: WebhookTerminalStatus): Promise<void> {
    await db
      .update(webhookInboxTable)
      .set({
        status,
        processedAt: new Date(),
        processingStartedAt: null,
        lastErrorCode: null,
      })
      .where(eq(webhookInboxTable.idempotencyKey, idempotencyKey));
  },

  async fail(idempotencyKey: string, errorCode: string): Promise<void> {
    await db
      .update(webhookInboxTable)
      .set({
        status: "failed",
        processingStartedAt: null,
        lastErrorCode: errorCode,
      })
      .where(and(
        eq(webhookInboxTable.idempotencyKey, idempotencyKey),
        eq(webhookInboxTable.status, "processing"),
      ));
  },
};

export async function hasProcessedCallCompletion(callId: string): Promise<boolean> {
  const [row] = await db
    .select({ idempotencyKey: webhookInboxTable.idempotencyKey })
    .from(webhookInboxTable)
    .where(and(
      eq(webhookInboxTable.provider, "openphone"),
      eq(webhookInboxTable.objectId, callId),
      eq(webhookInboxTable.eventType, "call.completed"),
      eq(webhookInboxTable.status, "processed"),
    ))
    .limit(1);
  return Boolean(row);
}
