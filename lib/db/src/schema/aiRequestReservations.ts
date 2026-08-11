import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Durable, privacy-minimized reservations for paid AI work. Request bodies,
// prompts, transcripts, images, provider credentials, and raw idempotency keys
// are never stored here; callers persist only hashes and bounded responses.
export const aiRequestReservationsTable = pgTable(
  "ai_request_reservations",
  {
    id: serial("id").primaryKey(),
    feature: text("feature").notNull(),
    scopeKey: text("scope_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("reserved"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<
      string,
      unknown
    > | null>(),
    failureCode: text("failure_code"),
    reservedAt: timestamp("reserved_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("ai_request_reservations_feature_scope_key_uidx").on(
      table.feature,
      table.scopeKey,
      table.idempotencyKey,
    ),
    index("ai_request_reservations_feature_scope_reserved_idx").on(
      table.feature,
      table.scopeKey,
      table.reservedAt,
    ),
    index("ai_request_reservations_expires_idx").on(table.expiresAt),
  ],
);

export type AiRequestReservation =
  typeof aiRequestReservationsTable.$inferSelect;
