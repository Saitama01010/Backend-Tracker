import { pgTable, text, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// One row per evaluated call. id = OpenPhone call id (one-to-one with phone_calls).
export const qaReviewsTable = pgTable(
  "qa_reviews",
  {
    id: text("id").primaryKey(),
    agentName: text("agent_name").notNull(),
    phoneNumber: text("phone_number"),
    callDate: timestamp("call_date", { withTimezone: true }).notNull(),
    lineTeam: text("line_team").notNull(),
    transcript: text("transcript"),
    aiSummary: text("ai_summary"),
    score: integer("score").notNull(),
    pass: boolean("pass").notNull(),
    criticalFail: boolean("critical_fail").notNull().default(false),
    strengths: jsonb("strengths").$type<string[]>().notNull().default([]),
    missedItems: jsonb("missed_items").$type<string[]>().notNull().default([]),
    categoryScores: jsonb("category_scores").$type<Record<string, number>>().notNull().default({}),
    reason: text("reason"),
    managerReviewRequired: boolean("manager_review_required").notNull().default(false),
    model: text("model"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("qa_reviews_agent_evaluated").on(t.agentName, t.evaluatedAt),
    index("qa_reviews_call_date").on(t.callDate),
  ],
);

export type QaReview = typeof qaReviewsTable.$inferSelect;
export type InsertQaReview = typeof qaReviewsTable.$inferInsert;

// Manager review tasks generated when a call fails QA.
export const managerQaTasksTable = pgTable(
  "manager_qa_tasks",
  {
    id: text("id").primaryKey(), // same as call id (one task per failed call)
    agentName: text("agent_name").notNull(),
    score: integer("score").notNull(),
    reason: text("reason").notNull(),
    criticalFail: boolean("critical_fail").notNull().default(false),
    status: text("status").notNull().default("open"), // open | resolved
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("manager_qa_tasks_status_created").on(t.status, t.createdAt),
    index("manager_qa_tasks_agent").on(t.agentName),
  ],
);

export type ManagerQaTask = typeof managerQaTasksTable.$inferSelect;
export type InsertManagerQaTask = typeof managerQaTasksTable.$inferInsert;
