import { pgTable, text, serial, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const actionAuditTable = pgTable("action_audit", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  username: text("username").notNull(),
  source: text("source").notNull(),
  capabilityName: text("capability_name").notNull(),
  targetResource: text("target_resource").notNull(),
  targetId: text("target_id"),
  previousValue: jsonb("previous_value"),
  newValue: jsonb("new_value"),
  success: boolean("success").notNull(),
  error: text("error"),
  instructionRef: text("instruction_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("action_audit_user_created_idx").on(table.userId, table.createdAt),
  index("action_audit_capability_created_idx").on(table.capabilityName, table.createdAt),
]);

export type ActionAudit = typeof actionAuditTable.$inferSelect;
export type InsertActionAudit = typeof actionAuditTable.$inferInsert;
