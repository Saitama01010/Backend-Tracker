import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ALL_PERMISSIONS = ["view_metrics", "view_attendance", "edit_attendance", "manage_members"] as const;
export type Permission = typeof ALL_PERMISSIONS[number];

export const portalUsersTable = pgTable("portal_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "edit", "view"] }).notNull().default("view"),
  permissions: text("permissions").notNull().default("[]"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPortalUserSchema = createInsertSchema(portalUsersTable).omit({ id: true, createdAt: true });
export type InsertPortalUser = z.infer<typeof insertPortalUserSchema>;
export type PortalUser = typeof portalUsersTable.$inferSelect;
