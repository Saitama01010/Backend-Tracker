import { pgTable, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";

// Per-call AI classification cache for the Onboarding line report.
// Keyed by OpenPhone call id so a refresh only ever classifies NEW calls.
export const onboardingClassificationsTable = pgTable("onboarding_classifications", {
  callId: text("call_id").primaryKey(),
  callType: text("call_type").notNull(), // onboarded | connection | other | no_transcript | error
  customerName: text("customer_name"),
  closerAgent: text("closer_agent"),
  mentionsTax: boolean("mentions_tax"), // null = no transcript / unknown
  txStatus: text("tx_status"),
  notes: text("notes"),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow().notNull(),
});

export type OnboardingClassification = typeof onboardingClassificationsTable.$inferSelect;
export type InsertOnboardingClassification = typeof onboardingClassificationsTable.$inferInsert;

// Singleton row tracking the state of the most recent report refresh.
export const onboardingReportStateTable = pgTable("onboarding_report_state", {
  id: text("id").primaryKey().default("singleton"),
  isRunning: boolean("is_running").notNull().default(false),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type OnboardingReportState = typeof onboardingReportStateTable.$inferSelect;
