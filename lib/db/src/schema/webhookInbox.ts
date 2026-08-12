import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const webhookInboxTable = pgTable("webhook_inbox", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  objectId: text("object_id"),
  payloadHash: text("payload_hash").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("received"),
  attempts: integer("attempts").notNull().default(0),
  firstReceivedAt: timestamp("first_received_at", { withTimezone: true }).notNull().defaultNow(),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull().defaultNow(),
  processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
}, (table) => [
  uniqueIndex("webhook_inbox_provider_event_uidx").on(table.provider, table.providerEventId),
  index("webhook_inbox_status_received_idx").on(table.status, table.lastReceivedAt),
  index("webhook_inbox_object_event_idx").on(table.objectId, table.eventType),
  check(
    "webhook_inbox_status_check",
    sql`${table.status} in ('received', 'processing', 'processed', 'ignored', 'failed')`,
  ),
]);

export type WebhookInboxRecord = typeof webhookInboxTable.$inferSelect;
export type InsertWebhookInboxRecord = typeof webhookInboxTable.$inferInsert;
