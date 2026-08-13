import { sql } from "drizzle-orm";
import { boolean, check, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const VALID_TEAMS = ["retention", "nsf", "cs", "killers"] as const;
export type TeamSlug = typeof VALID_TEAMS[number];

export const teamAgentsTable = pgTable("team_agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  nameNormalized: text("name_normalized").notNull(),
  arabicName: text("arabic_name"),
  arabicNameNormalized: text("arabic_name_normalized"),
  email: text("email"),
  emailNormalized: text("email_normalized"),
  shift: text("shift"),
  notes: text("notes"),
  team: text("team", { enum: VALID_TEAMS }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("team_agents_name_normalized_uidx").on(table.nameNormalized),
  uniqueIndex("team_agents_arabic_name_normalized_uidx")
    .on(table.arabicNameNormalized)
    .where(sql`${table.arabicNameNormalized} is not null`),
  uniqueIndex("team_agents_email_normalized_uidx")
    .on(table.emailNormalized)
    .where(sql`${table.emailNormalized} is not null`),
  check(
    "team_agents_name_normalized_required",
    sql`${table.nameNormalized} <> ''
      and ${table.nameNormalized} = lower(regexp_replace(btrim(normalize(${table.name}, NFKC)), '[[:space:]]+', ' ', 'g'))`,
  ),
  check(
    "team_agents_arabic_identity_pair",
    sql`(${table.arabicName} is null and ${table.arabicNameNormalized} is null)
      or (${table.arabicName} is not null
        and ${table.arabicNameNormalized} is not null
        and ${table.arabicNameNormalized} <> ''
        and ${table.arabicNameNormalized} = regexp_replace(btrim(normalize(${table.arabicName}, NFKC)), '[[:space:]]+', ' ', 'g'))`,
  ),
  check(
    "team_agents_email_identity_pair",
    sql`(${table.email} is null and ${table.emailNormalized} is null)
      or (${table.email} is not null
        and ${table.emailNormalized} is not null
        and ${table.emailNormalized} <> ''
        and ${table.emailNormalized} = lower(btrim(${table.email})))`,
  ),
]);

export const insertTeamAgentSchema = createInsertSchema(teamAgentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTeamAgent = z.infer<typeof insertTeamAgentSchema>;
export type TeamAgent = typeof teamAgentsTable.$inferSelect;
