import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { VALID_TEAMS } from "./teamAgents";
import { portalUsersTable } from "./users";

export const CANONICAL_DASHBOARD_TABS = [
  "backend-stats",
  "retention",
  "cs",
  "nsf",
  "rmk",
  "missed-no-cb",
  "callback-review",
  "violations",
  "qa",
  "onboarding",
] as const;
export type CanonicalDashboardTab = typeof CANONICAL_DASHBOARD_TABS[number];

export const portalUserTeamGrantsTable = pgTable("portal_user_team_grants", {
  id: serial("id").primaryKey(),
  portalUserId: integer("portal_user_id")
    .notNull()
    .references(() => portalUsersTable.id, { onDelete: "cascade" }),
  team: text("team", { enum: VALID_TEAMS }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("portal_user_team_grants_user_team_uidx").on(table.portalUserId, table.team),
  index("portal_user_team_grants_user_idx").on(table.portalUserId),
  check("portal_user_team_grants_team_check", sql`${table.team} in ('retention', 'nsf', 'cs', 'killers')`),
]);

export const portalUserTabGrantsTable = pgTable("portal_user_tab_grants", {
  id: serial("id").primaryKey(),
  portalUserId: integer("portal_user_id")
    .notNull()
    .references(() => portalUsersTable.id, { onDelete: "cascade" }),
  tab: text("tab", { enum: CANONICAL_DASHBOARD_TABS }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("portal_user_tab_grants_user_tab_uidx").on(table.portalUserId, table.tab),
  index("portal_user_tab_grants_user_idx").on(table.portalUserId),
  check(
    "portal_user_tab_grants_tab_check",
    sql`${table.tab} in ('backend-stats', 'retention', 'cs', 'nsf', 'rmk', 'missed-no-cb', 'callback-review', 'violations', 'qa', 'onboarding')`,
  ),
]);

export type PortalUserTeamGrant = typeof portalUserTeamGrantsTable.$inferSelect;
export type PortalUserTabGrant = typeof portalUserTabGrantsTable.$inferSelect;
