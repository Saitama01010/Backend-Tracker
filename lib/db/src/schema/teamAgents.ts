import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const VALID_TEAMS = ["retention", "nsf", "cs"] as const;
export type TeamSlug = typeof VALID_TEAMS[number];

export const teamAgentsTable = pgTable("team_agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  team: text("team", { enum: VALID_TEAMS }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTeamAgentSchema = createInsertSchema(teamAgentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTeamAgent = z.infer<typeof insertTeamAgentSchema>;
export type TeamAgent = typeof teamAgentsTable.$inferSelect;
