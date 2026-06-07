import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ALL_PERMISSIONS = ["view_metrics", "view_attendance", "edit_attendance", "manage_members", "view_missed_tables"] as const;
export type Permission = typeof ALL_PERMISSIONS[number];

export const ALL_TEAM_ACCESS = ["retention", "nsf", "cs"] as const;
export type TeamAccess = typeof ALL_TEAM_ACCESS[number];

export const portalUsersTable = pgTable("portal_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "edit", "view"] }).notNull().default("view"),
  permissions: text("permissions").notNull().default("[]"),
  // null = unrestricted (sees all teams); "retention"|"nsf"|"cs" = scoped to that team only
  teamAccess: text("team_access"),
  // null = all tabs; JSON string[] = explicit allowlist of tab values
  allowedTabs: text("allowed_tabs"),
  // null = all agents; JSON string[] = explicit allowlist of agent display names
  allowedAgents: text("allowed_agents"),
  // null = all sub-tabs; JSON string[] subset of {"call","files","day"}
  allowedSubTabs: text("allowed_sub_tabs"),
  // true = date pickers locked to today (no PresetFilter, no history)
  lockToToday: boolean("lock_to_today").notNull().default(false),
  // true = Samia replies "fuck you {username}" to anything this user asks
  samiaCurse: boolean("samia_curse").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPortalUserSchema = createInsertSchema(portalUsersTable).omit({ id: true, createdAt: true });
export type InsertPortalUser = z.infer<typeof insertPortalUserSchema>;
export type PortalUser = typeof portalUsersTable.$inferSelect;
