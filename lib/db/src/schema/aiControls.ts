import { index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Accepted paid-AI requests. This table is intentionally small and contains no
// prompts, transcripts, image data, or provider credentials.
export const aiRequestUsageTable = pgTable(
  "ai_request_usage",
  {
    id: serial("id").primaryKey(),
    feature: text("feature").notNull(),
    userId: integer("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("ai_request_usage_feature_user_created").on(t.feature, t.userId, t.createdAt),
    index("ai_request_usage_created").on(t.createdAt),
  ],
);
// Durable audit of biweekly QA scheduler outcomes. Results contain call IDs,
// agent names, and skip reasons only; transcripts are never stored here.
export const qaBiweeklyRunsTable = pgTable(
  "qa_biweekly_runs",
  {
    id: serial("id").primaryKey(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("running"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("qa_biweekly_runs_started").on(t.startedAt)],
);
