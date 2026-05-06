import { pgTable, text, serial, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const attendanceMembersTable = pgTable("attendance_members", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  shift: text("shift").notNull().default(""),
  department: text("department").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAttendanceMemberSchema = createInsertSchema(attendanceMembersTable).omit({ id: true, createdAt: true });
export type InsertAttendanceMember = z.infer<typeof insertAttendanceMemberSchema>;
export type AttendanceMember = typeof attendanceMembersTable.$inferSelect;

export const attendanceRecordsTable = pgTable(
  "attendance_records",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => attendanceMembersTable.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    status: text("status").notNull().default(""),
    note: text("note"),
    coaching: boolean("coaching").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique("attendance_records_member_date").on(t.memberId, t.date)],
);

export const insertAttendanceRecordSchema = createInsertSchema(attendanceRecordsTable).omit({ id: true, updatedAt: true });
export type InsertAttendanceRecord = z.infer<typeof insertAttendanceRecordSchema>;
export type AttendanceRecord = typeof attendanceRecordsTable.$inferSelect;
