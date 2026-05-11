import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const violationVerificationsTable = pgTable(
  "violation_verifications",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),            // e.g. "late:Ahmed Ayman:2026-05-09"
    type: text("type").notNull(),           // "late_login" | "availability_gap"
    member: text("member").notNull(),
    department: text("department").notNull(),
    date: text("date").notNull(),
    details: text("details").notNull(),     // JSON stringified full row data
    verifiedBy: text("verified_by").notNull().default("admin"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("violation_verifications_key_unique").on(t.key)],
);

export const insertViolationVerificationSchema = createInsertSchema(violationVerificationsTable).omit({ id: true, verifiedAt: true });
export type InsertViolationVerification = z.infer<typeof insertViolationVerificationSchema>;
export type ViolationVerification = typeof violationVerificationsTable.$inferSelect;
