import { attendanceMembersTable, attendanceRecordsTable, db } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  ATTENDANCE_STATUSES,
  resolveAttendanceMember,
  type AttendanceMemberMatch,
  type AttendanceStatus,
} from "./attendancePolicy.js";

export interface AttendanceWriteInput {
  memberId?: number;
  memberName?: string;
  date: string;
  status: AttendanceStatus;
  note?: string | null;
  coaching?: boolean;
  overwrite?: boolean;
}

export type AttendanceWriteResult =
  | {
      kind: "saved";
      action: "created" | "updated" | "unchanged";
      member: typeof attendanceMembersTable.$inferSelect;
      previous: typeof attendanceRecordsTable.$inferSelect | null;
      record: typeof attendanceRecordsTable.$inferSelect;
    }
  | {
      kind: "conflict";
      member: typeof attendanceMembersTable.$inferSelect;
      existing: typeof attendanceRecordsTable.$inferSelect;
      requestedStatus: AttendanceStatus;
    }
  | { kind: "member_ambiguous"; match: Extract<AttendanceMemberMatch, { kind: "ambiguous" }> }
  | { kind: "member_missing" };

type AttendanceMember = typeof attendanceMembersTable.$inferSelect;

export type AttendanceBatchWriteResult =
  | {
      kind: "saved";
      action: "created" | "updated" | "unchanged";
      member: AttendanceMember;
    }
  | {
      kind: "conflict";
      member: AttendanceMember;
      existing: { status: string };
      requestedStatus: AttendanceStatus;
    }
  | { kind: "member_ambiguous"; match: Extract<AttendanceMemberMatch, { kind: "ambiguous" }> }
  | { kind: "member_missing" };

export function isAttendanceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value;
}

export async function activeAttendanceMembers() {
  return db.select().from(attendanceMembersTable)
    .where(eq(attendanceMembersTable.active, true))
    .orderBy(attendanceMembersTable.name);
}

export function resolveActiveAttendanceMemberFromList(
  members: readonly AttendanceMember[],
  memberId?: number,
  memberName?: string,
):
  | { kind: "unique"; member: AttendanceMember }
  | { kind: "ambiguous"; match: Extract<AttendanceMemberMatch, { kind: "ambiguous" }> }
  | { kind: "missing" } {
  if (memberId !== undefined) {
    const member = members.find((candidate) => candidate.id === memberId);
    return member ? { kind: "unique", member } : { kind: "missing" };
  }
  const match = resolveAttendanceMember(memberName ?? "", [...members]);
  if (match.kind === "unique") {
    const member = members.find((candidate) => candidate.id === match.member.id);
    return member ? { kind: "unique", member } : { kind: "missing" };
  }
  return match.kind === "ambiguous" ? { kind: "ambiguous", match } : { kind: "missing" };
}

export async function resolveActiveAttendanceMember(
  memberId?: number,
  memberName?: string,
): Promise<
  | { kind: "unique"; member: typeof attendanceMembersTable.$inferSelect }
  | { kind: "ambiguous"; match: Extract<AttendanceMemberMatch, { kind: "ambiguous" }> }
  | { kind: "missing" }
> {
  const members = await activeAttendanceMembers();
  return resolveActiveAttendanceMemberFromList(members, memberId, memberName);
}

export async function getAttendanceRecord(memberId: number, date: string) {
  const [record] = await db.select().from(attendanceRecordsTable).where(and(
    eq(attendanceRecordsTable.memberId, memberId),
    eq(attendanceRecordsTable.date, date),
  )).limit(1);
  return record ?? null;
}

export async function setAttendanceRecord(input: AttendanceWriteInput): Promise<AttendanceWriteResult> {
  if (!isAttendanceDate(input.date)) throw new Error("Attendance date must be a valid YYYY-MM-DD date");
  if (!(ATTENDANCE_STATUSES as readonly string[]).includes(input.status)) throw new Error("Attendance status is invalid");
  const resolved = await resolveActiveAttendanceMember(input.memberId, input.memberName);
  if (resolved.kind === "missing") return { kind: "member_missing" };
  if (resolved.kind === "ambiguous") return { kind: "member_ambiguous", match: resolved.match };

  const member = resolved.member;
  const previous = await getAttendanceRecord(member.id, input.date);
  if (previous && previous.status !== input.status && !input.overwrite) {
    return { kind: "conflict", member, existing: previous, requestedStatus: input.status };
  }
  if (previous
    && previous.status === input.status
    && (input.note === undefined || previous.note === input.note)
    && (input.coaching === undefined || previous.coaching === input.coaching)) {
    return { kind: "saved", action: "unchanged", member, previous, record: previous };
  }

  await db.insert(attendanceRecordsTable).values({
    memberId: member.id,
    date: input.date,
    status: input.status,
    note: input.note ?? previous?.note ?? null,
    coaching: input.coaching ?? previous?.coaching ?? false,
  }).onConflictDoUpdate({
    target: [attendanceRecordsTable.memberId, attendanceRecordsTable.date],
    set: {
      status: input.status,
      note: input.note ?? previous?.note ?? null,
      coaching: input.coaching ?? previous?.coaching ?? false,
      updatedAt: new Date(),
    },
  });

  const persisted = await getAttendanceRecord(member.id, input.date);
  if (!persisted || persisted.status !== input.status
    || (input.note !== undefined && persisted.note !== input.note)
    || (input.coaching !== undefined && persisted.coaching !== input.coaching)) {
    throw new Error("Attendance persistence verification failed");
  }
  return { kind: "saved", action: previous ? "updated" : "created", member, previous, record: persisted };
}

/**
 * Applies a batch with one member lookup, one existing-record read, one bulk
 * upsert, and one verification read. Planning remains sequential so duplicate
 * member/date inputs produce the same created/updated/conflict actions as the
 * former record-at-a-time implementation.
 */
export async function setAttendanceRecords(
  inputs: readonly AttendanceWriteInput[],
  members?: readonly AttendanceMember[],
): Promise<AttendanceBatchWriteResult[]> {
  for (const input of inputs) {
    if (!isAttendanceDate(input.date)) throw new Error("Attendance date must be a valid YYYY-MM-DD date");
    if (!(ATTENDANCE_STATUSES as readonly string[]).includes(input.status)) throw new Error("Attendance status is invalid");
  }

  const activeMembers = members ?? await activeAttendanceMembers();
  const resolved = inputs.map((input) => ({
    input,
    match: resolveActiveAttendanceMemberFromList(activeMembers, input.memberId, input.memberName),
  }));
  const uniqueMatches = resolved.filter((item): item is typeof item & {
    match: Extract<typeof item.match, { kind: "unique" }>;
  } => item.match.kind === "unique");
  if (uniqueMatches.length === 0) {
    return resolved.map(({ match }) => match.kind === "ambiguous"
      ? { kind: "member_ambiguous", match: match.match }
      : { kind: "member_missing" });
  }

  const memberIds = [...new Set(uniqueMatches.map((item) => item.match.member.id))];
  const dates = [...new Set(uniqueMatches.map((item) => item.input.date))];

  return db.transaction(async (tx) => {
    const existingRows = await tx.select().from(attendanceRecordsTable).where(and(
      inArray(attendanceRecordsTable.memberId, memberIds),
      inArray(attendanceRecordsTable.date, dates),
    ));
    type State = { status: string; note: string | null; coaching: boolean };
    const states = new Map<string, State>(existingRows.map((row) => [
      `${row.memberId}:${row.date}`,
      { status: row.status, note: row.note, coaching: row.coaching },
    ]));
    const writes = new Map<string, {
      memberId: number;
      date: string;
      status: string;
      note: string | null;
      coaching: boolean;
      updatedAt: Date;
    }>();
    const results: AttendanceBatchWriteResult[] = [];
    const updatedAt = new Date();

    for (const { input, match } of resolved) {
      if (match.kind === "missing") {
        results.push({ kind: "member_missing" });
        continue;
      }
      if (match.kind === "ambiguous") {
        results.push({ kind: "member_ambiguous", match: match.match });
        continue;
      }

      const member = match.member;
      const key = `${member.id}:${input.date}`;
      const previous = states.get(key);
      const existedBeforeInput = previous !== undefined;
      if (previous && previous.status !== input.status && !input.overwrite) {
        results.push({
          kind: "conflict",
          member,
          existing: previous,
          requestedStatus: input.status,
        });
        continue;
      }
      if (
        previous
        && previous.status === input.status
        && (input.note === undefined || previous.note === input.note)
        && (input.coaching === undefined || previous.coaching === input.coaching)
      ) {
        results.push({ kind: "saved", action: "unchanged", member });
        continue;
      }

      const next: State = {
        status: input.status,
        note: input.note ?? previous?.note ?? null,
        coaching: input.coaching ?? previous?.coaching ?? false,
      };
      states.set(key, next);
      writes.set(key, { memberId: member.id, date: input.date, ...next, updatedAt });
      results.push({
        kind: "saved",
        action: existedBeforeInput ? "updated" : "created",
        member,
      });
    }

    if (writes.size > 0) {
      await tx.insert(attendanceRecordsTable).values([...writes.values()]).onConflictDoUpdate({
        target: [attendanceRecordsTable.memberId, attendanceRecordsTable.date],
        set: {
          status: sql`excluded.status`,
          note: sql`excluded.note`,
          coaching: sql`excluded.coaching`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

      const verifiedRows = await tx.select().from(attendanceRecordsTable).where(and(
        inArray(attendanceRecordsTable.memberId, memberIds),
        inArray(attendanceRecordsTable.date, dates),
      ));
      const verified = new Map(verifiedRows.map((row) => [`${row.memberId}:${row.date}`, row]));
      for (const [key, expected] of writes) {
        const actual = verified.get(key);
        if (!actual
          || actual.status !== expected.status
          || actual.note !== expected.note
          || actual.coaching !== expected.coaching) {
          throw new Error("Attendance persistence verification failed");
        }
      }
    }

    return results;
  });
}

export async function setAttendanceNote(input: {
  memberId?: number;
  memberName?: string;
  date: string;
  note: string;
}): Promise<AttendanceWriteResult> {
  if (!isAttendanceDate(input.date)) throw new Error("Attendance date must be a valid YYYY-MM-DD date");
  if (input.note.length > 1_000) throw new Error("Attendance note is too long");
  const resolved = await resolveActiveAttendanceMember(input.memberId, input.memberName);
  if (resolved.kind === "missing") return { kind: "member_missing" };
  if (resolved.kind === "ambiguous") return { kind: "member_ambiguous", match: resolved.match };
  const previous = await getAttendanceRecord(resolved.member.id, input.date);
  if (!previous) throw new Error(`No attendance record exists for ${resolved.member.name} on ${input.date}`);
  return setAttendanceRecord({
    memberId: resolved.member.id,
    date: input.date,
    status: previous.status as AttendanceStatus,
    note: input.note,
    coaching: previous.coaching,
    overwrite: true,
  });
}
