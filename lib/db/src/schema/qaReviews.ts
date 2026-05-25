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
    // department detected by the AI (Retention | CS | NSF) — may differ from lineTeam
    department: text("department").notNull().default("Retention"),
    transcript: text("transcript"),
    aiSummary: text("ai_summary"),
    score: integer("score").notNull(),
    // sub-scores from the rubric
    softSkillsScore: integer("soft_skills_score").notNull().default(0),
    protocolScore: integer("protocol_score").notNull().default(0),
    pass: boolean("pass").notNull(),
    criticalFail: boolean("critical_fail").notNull().default(false),
    strengths: jsonb("strengths").$type<string[]>().notNull().default([]),
    missedItems: jsonb("missed_items").$type<string[]>().notNull().default([]),
    criticalIssues: jsonb("critical_issues").$type<string[]>().notNull().default([]),
    categoryScores: jsonb("category_scores").$type<Record<string, number>>().notNull().default({}),
    reason: text("reason"),
    managerReviewRequired: boolean("manager_review_required").notNull().default(false),
    model: text("model"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("qa_reviews_agent_evaluated").on(t.agentName, t.evaluatedAt),
    index("qa_reviews_call_date").on(t.callDate),
    index("qa_reviews_department").on(t.department),
  ],
);

export type QaReview = typeof qaReviewsTable.$inferSelect;
export type InsertQaReview = typeof qaReviewsTable.$inferInsert;

// Manager review tasks (auto-flagged + weekly-assigned).
export const managerQaTasksTable = pgTable(
  "manager_qa_tasks",
  {
    id: text("id").primaryKey(), // same as call id (one task per call)
    agentName: text("agent_name").notNull(),
    department: text("department").notNull().default("Retention"),
    aiScore: integer("ai_score").notNull().default(0),
    score: integer("score").notNull(), // kept for backward compat = aiScore at insert time
    reason: text("reason").notNull(),
    criticalFail: boolean("critical_fail").notNull().default(false),
    // source: auto_flag | weekly_lowest | weekly_random | manual
    source: text("source").notNull().default("auto_flag"),
    status: text("status").notNull().default("open"), // open | resolved
    // Manager review outputs
    managerScore: integer("manager_score"),
    variance: integer("variance"),    // managerScore - aiScore
    finalScore: integer("final_score"), // last word — manager's call
    comments: text("comments"),
    coachingComplete: boolean("coaching_complete").notNull().default(false),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("manager_qa_tasks_status_created").on(t.status, t.createdAt),
    index("manager_qa_tasks_agent").on(t.agentName),
    index("manager_qa_tasks_department").on(t.department),
  ],
);

export type ManagerQaTask = typeof managerQaTasksTable.$inferSelect;
export type InsertManagerQaTask = typeof managerQaTasksTable.$inferInsert;
