import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const samiaMessagesTable = pgTable("samia_messages", {
  id: serial("id").primaryKey(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  images: jsonb("images").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSamiaMessageSchema = createInsertSchema(samiaMessagesTable).omit({ id: true, createdAt: true });
export type InsertSamiaMessage = z.infer<typeof insertSamiaMessageSchema>;
export type SamiaMessage = typeof samiaMessagesTable.$inferSelect;
