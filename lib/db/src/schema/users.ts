import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { teamAgentsTable, VALID_TEAMS } from "./teamAgents";

export const ALL_PERMISSIONS = ["view_metrics", "view_attendance", "edit_attendance", "manage_members", "view_missed_tables"] as const;
export type Permission = typeof ALL_PERMISSIONS[number];

export const ALL_TEAM_ACCESS = ["retention", "nsf", "cs"] as const;
export type TeamAccess = typeof ALL_TEAM_ACCESS[number];

export const CANONICAL_ACCESS_ROLES = ["agent", "manager", "admin"] as const;
export type CanonicalAccessRole = typeof CANONICAL_ACCESS_ROLES[number];

export const portalUsersTable = pgTable("portal_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordPolicyVersion: integer("password_policy_version").notNull().default(1),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
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
  // true = hide the Backend Statistics tab for this user
  hideBackendStats: boolean("hide_backend_stats").notNull().default(false),
  // NULL preserves the existing authorization model until an administrator
  // explicitly migrates this account in User Management.
  accessRole: text("access_role", { enum: CANONICAL_ACCESS_ROLES }),
  teamAgentId: integer("team_agent_id")
    .references(() => teamAgentsTable.id, { onDelete: "restrict" }),
  primaryTeam: text("primary_team", { enum: VALID_TEAMS }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("portal_users_team_agent_id_uidx")
    .on(table.teamAgentId)
    .where(sql`${table.teamAgentId} is not null`),
  check(
    "portal_users_access_role_check",
    sql`${table.accessRole} is null or ${table.accessRole} in ('agent', 'manager', 'admin')`,
  ),
  check(
    "portal_users_primary_team_check",
    sql`${table.primaryTeam} is null or ${table.primaryTeam} in ('retention', 'nsf', 'cs', 'killers')`,
  ),
  check(
    "portal_users_password_policy_version_check",
    sql`${table.passwordPolicyVersion} >= 0`,
  ),
  check(
    "portal_users_canonical_access_shape_check",
    sql`(${table.accessRole} is null and ${table.teamAgentId} is null and ${table.primaryTeam} is null)
      or (${table.accessRole} = 'agent' and ${table.teamAgentId} is not null and ${table.primaryTeam} is null)
      or (${table.accessRole} = 'manager' and ${table.teamAgentId} is null and ${table.primaryTeam} is not null)
      or (${table.accessRole} = 'admin' and ${table.teamAgentId} is null and ${table.primaryTeam} is null)`,
  ),
]);

export const insertPortalUserSchema = createInsertSchema(portalUsersTable).omit({ id: true, createdAt: true });
export type InsertPortalUser = z.infer<typeof insertPortalUserSchema>;
export type PortalUser = typeof portalUsersTable.$inferSelect;
