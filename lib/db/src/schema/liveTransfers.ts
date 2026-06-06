import { pgTable, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";

// Per-call AI/keyword classification cache for inbound live transfers
// (partner reps from Aspire / Resync handing off a client). Keyed by OpenPhone
// call id so a refresh only ever classifies NEW incoming calls.
export const liveTransferClassificationsTable = pgTable("live_transfer_classifications", {
  callId: text("call_id").primaryKey(),
  isLive: boolean("is_live").notNull().default(false),
  company: text("company"), // "Aspire" | "Resync" | null (unspecified)
  agent: text("agent"), // transferring partner rep name, if stated
  evidence: text("evidence"), // short quote/paraphrase of the intro line
  txStatus: text("tx_status"), // transcript status: completed | notfound | none
  classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow().notNull(),
});

export type LiveTransferClassification = typeof liveTransferClassificationsTable.$inferSelect;
export type InsertLiveTransferClassification = typeof liveTransferClassificationsTable.$inferInsert;

// Singleton row tracking the state of the most recent live-transfer refresh.
export const liveTransferStateTable = pgTable("live_transfer_state", {
  id: text("id").primaryKey().default("singleton"),
  isRunning: boolean("is_running").notNull().default(false),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type LiveTransferState = typeof liveTransferStateTable.$inferSelect;
