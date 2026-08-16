import {
  attendanceMembersTable,
  attendanceRecordsTable,
  db,
  phoneCallsTable,
} from "@workspace/db";
import { and, eq, gte, ilike, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { attendanceImportMemberKey } from "../../lib/databasePerformance.js";
import { escapeLikePattern } from "../../lib/sensitiveWorkflowPolicy.js";

export type AttendanceMember = typeof attendanceMembersTable.$inferSelect;
export type AttendanceMemberInsert = typeof attendanceMembersTable.$inferInsert;
export type AttendanceRecordInsert = typeof attendanceRecordsTable.$inferInsert;

export const attendanceRecordDate = sql<string>`coalesce(${attendanceRecordsTable.dateValue}::text, ${attendanceRecordsTable.date})`;

export const attendanceRecordSelection = {
  id: attendanceRecordsTable.id,
  memberId: attendanceRecordsTable.memberId,
  date: attendanceRecordDate,
  status: attendanceRecordsTable.status,
  note: attendanceRecordsTable.note,
  coaching: attendanceRecordsTable.coaching,
  updatedAt: attendanceRecordsTable.updatedAt,
};

export interface AttendanceImportMember {
  key: string;
  name: string;
  shift: string;
  department: string;
  records: readonly { date: string; status: string }[];
}

export const attendanceRepository = {
  listMembers(input: { includeInactive: boolean; order: "department" | "name" }) {
    const query = db.select().from(attendanceMembersTable)
      .where(input.includeInactive ? undefined : eq(attendanceMembersTable.active, true));
    return input.order === "department"
      ? query.orderBy(attendanceMembersTable.department, attendanceMembersTable.name)
      : query.orderBy(attendanceMembersTable.name);
  },

  async findMemberById(id: number) {
    const [member] = await db.select().from(attendanceMembersTable)
      .where(eq(attendanceMembersTable.id, id)).limit(1);
    return member ?? null;
  },

  async createMember(values: AttendanceMemberInsert) {
    const [member] = await db.insert(attendanceMembersTable).values(values).returning();
    return member;
  },

  async updateMember(id: number, values: Partial<AttendanceMemberInsert>) {
    const [member] = await db.update(attendanceMembersTable).set(values)
      .where(eq(attendanceMembersTable.id, id)).returning();
    return member;
  },

  listRecordsInRange(memberIds: readonly number[], from: string, to: string) {
    if (memberIds.length === 0) return Promise.resolve([]);
    return db.select(attendanceRecordSelection).from(attendanceRecordsTable).where(and(
      inArray(attendanceRecordsTable.memberId, [...memberIds]),
      gte(attendanceRecordDate, from),
      lte(attendanceRecordDate, to),
    ));
  },

  listRecordsForDate(memberIds: readonly number[], date: string) {
    if (memberIds.length === 0) return Promise.resolve([]);
    return db.select(attendanceRecordSelection).from(attendanceRecordsTable).where(and(
      inArray(attendanceRecordsTable.memberId, [...memberIds]),
      eq(attendanceRecordDate, date),
    ));
  },

  async persistImport(members: readonly AttendanceImportMember[]) {
    return db.transaction(async (tx) => {
      const existingMembers = await tx.select().from(attendanceMembersTable)
        .orderBy(attendanceMembersTable.id);
      const memberIds = new Map<string, number>();
      for (const member of existingMembers) {
        const key = attendanceImportMemberKey(member.department, member.name);
        if (!memberIds.has(key)) memberIds.set(key, member.id);
      }

      const missingMembers = members.filter((member) => !memberIds.has(member.key));
      if (missingMembers.length > 0) {
        const insertedMembers = await tx.insert(attendanceMembersTable)
          .values(missingMembers.map((member) => ({
            name: member.name,
            shift: member.shift,
            department: member.department,
          })))
          .returning({
            id: attendanceMembersTable.id,
            name: attendanceMembersTable.name,
            department: attendanceMembersTable.department,
          });
        for (const member of insertedMembers) {
          memberIds.set(attendanceImportMemberKey(member.department, member.name), member.id);
        }
      }

      const pendingRecords = members.flatMap((member) => {
        const memberId = memberIds.get(member.key);
        if (memberId === undefined) throw new Error("Attendance import member persistence failed");
        return member.records.map((record) => ({ memberId, ...record, dateValue: record.date }));
      });
      const chunkSize = 500;
      for (let offset = 0; offset < pendingRecords.length; offset += chunkSize) {
        await tx.insert(attendanceRecordsTable)
          .values(pendingRecords.slice(offset, offset + chunkSize))
          .onConflictDoNothing();
      }
      return missingMembers.length;
    });
  },

  listFirstQuoCalls(dayStartUtc: Date, dayEndUtc: Date) {
    return db.select({
      agentName: phoneCallsTable.agentName,
      firstCallAt: sql<Date | null>`min(${phoneCallsTable.createdAt})`,
    }).from(phoneCallsTable).where(and(
      gte(phoneCallsTable.createdAt, dayStartUtc),
      lte(phoneCallsTable.createdAt, dayEndUtc),
      isNotNull(phoneCallsTable.agentName),
      or(
        eq(phoneCallsTable.direction, "outgoing"),
        and(eq(phoneCallsTable.direction, "incoming"), eq(phoneCallsTable.status, "completed")),
      ),
    )).groupBy(phoneCallsTable.agentName);
  },

  async listRecordedMemberIds(date: string) {
    const rows = await db.select({ memberId: attendanceRecordsTable.memberId })
      .from(attendanceRecordsTable).where(eq(attendanceRecordDate, date));
    return rows.map((row) => row.memberId);
  },

  async insertRecordsIfMissing(records: readonly AttendanceRecordInsert[]) {
    if (records.length === 0) return;
    await db.insert(attendanceRecordsTable).values([...records]).onConflictDoNothing();
  },

  listAgentContactCalls(agent: string, dayStartUtc: Date, dayEndUtc: Date) {
    return db.select({
      participant: phoneCallsTable.participant,
      direction: phoneCallsTable.direction,
      status: phoneCallsTable.status,
      durationSeconds: phoneCallsTable.durationSeconds,
      createdAt: phoneCallsTable.createdAt,
      agentName: phoneCallsTable.agentName,
    }).from(phoneCallsTable).where(and(
      ilike(phoneCallsTable.agentName, `%${escapeLikePattern(agent)}%`),
      gte(phoneCallsTable.createdAt, dayStartUtc),
      lte(phoneCallsTable.createdAt, dayEndUtc),
    )).orderBy(sql`${phoneCallsTable.createdAt} asc`);
  },
};
