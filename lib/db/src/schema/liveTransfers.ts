import { pgTable, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";

// Per-call AI/keyword classification cache for inbound live transfers. Covers
// both PARTNER warm-transfers (external reps from Aspire / Resync / Clarity /
// Concordia handing off a client) and INTERNAL transfers (one of our own
// departments — CS, NSF, Retention, Onboarding, etc. — passing the client to
// this team). Keyed by OpenPhone call id so a refresh only classifies NEW calls.
export const liveTransferClassificationsTable = pgTable("live_transfer_classifications", {
  callId: text("call_id").primaryKey(),
  isLive: boolean("is_live").notNull().default(false),
  kind: text("kind"), // "partner" | "internal" | null (not a transfer)
  company: text("company"), // partner: company name; internal: department; null if unspecified
  agent: text("agent"), // transferring rep/agent name, if stated
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
