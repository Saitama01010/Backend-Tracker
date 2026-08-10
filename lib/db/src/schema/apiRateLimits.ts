import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const apiRateLimitsTable = pgTable("api_rate_limits", {
  scopeKey: text("scope_key").notNull(),
  action: text("action").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  requestCount: integer("request_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.scopeKey, table.action] }),
]);
