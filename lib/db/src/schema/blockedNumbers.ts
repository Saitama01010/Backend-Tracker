import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const blockedNumbersTable = pgTable("blocked_numbers", {
  number: text("number").primaryKey(),
  note:   text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BlockedNumber = typeof blockedNumbersTable.$inferSelect;
