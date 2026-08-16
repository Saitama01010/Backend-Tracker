import {
  attendanceRepository,
  attendanceRecordDate,
  attendanceRecordSelection,
  type AttendanceMember,
  type AttendanceRecordView,
  type AttendanceRecordWrite,
} from "../modules/attendance/attendance.repository.js";
import {
  attendanceNoteForWrite,
  canonicalAttendanceStatus,
  resolveAttendanceMember,
  type AttendanceMemberMatch,
  type AttendanceStatus,
} from "./attendancePolicy.js";
import { isCalendarDate } from "./businessTime.js";

export interface AttendanceWriteInput {
  memberId?: number;
  memberName?: string;
  date: string;
  status: string;
  note?: string | null;
  coaching?: boolean;
  overwrite?: boolean;
}

export type AttendanceWriteResult =
  | {
      kind: "saved";
      action: "created" | "updated" | "unchanged";
      member: AttendanceMember;
      previous: AttendanceRecordView | null;
      record: AttendanceRecordView;
    }
  | {
      kind: "conflict";
      member: AttendanceMember;
      existing: AttendanceRecordView;
      requestedStatus: AttendanceStatus;
    }
  | { kind: "member_ambiguous"; match: Extract<AttendanceMemberMatch, { kind: "ambiguous" }> }
  | { kind: "member_missing" };

export type { AttendanceRecordView };

export { attendanceRecordDate, attendanceRecordSelection };

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
  return isCalendarDate(value);
}

export async function activeAttendanceMembers() {
  return attendanceRepository.listMembers({ includeInactive: false, order: "name" });
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
  | { kind: "unique"; member: AttendanceMember }
  | { kind: "ambiguous"; match: Extract<AttendanceMemberMatch, { kind: "ambiguous" }> }
  | { kind: "missing" }
> {
  const members = await activeAttendanceMembers();
  return resolveActiveAttendanceMemberFromList(members, memberId, memberName);
}

export async function getAttendanceRecord(memberId: number, date: string) {
  return attendanceRepository.getRecord(memberId, date);
}

export async function setAttendanceRecord(input: AttendanceWriteInput): Promise<AttendanceWriteResult> {
  if (!isAttendanceDate(input.date)) throw new Error("Attendance date must be a valid YYYY-MM-DD date");
  const status = canonicalAttendanceStatus(input.status);
  if (!status) throw new Error("Attendance status is invalid");
  const resolved = await resolveActiveAttendanceMember(input.memberId, input.memberName);
  if (resolved.kind === "missing") return { kind: "member_missing" };
  if (resolved.kind === "ambiguous") return { kind: "member_ambiguous", match: resolved.match };

  const member = resolved.member;
  const previous = await getAttendanceRecord(member.id, input.date);
  if (previous && previous.status !== status && !input.overwrite) {
    return { kind: "conflict", member, existing: previous, requestedStatus: status };
  }
  if (previous
    && previous.status === status
    && (input.note === undefined || previous.note === input.note)
    && (input.coaching === undefined || previous.coaching === input.coaching)) {
    return { kind: "saved", action: "unchanged", member, previous, record: previous };
  }

  const note = attendanceNoteForWrite(input.note, previous?.note ?? null);
  await attendanceRepository.upsertRecord({
    memberId: member.id,
    date: input.date,
    dateValue: input.date,
    status,
    note,
    coaching: input.coaching ?? previous?.coaching ?? false,
  });

  const persisted = await getAttendanceRecord(member.id, input.date);
  if (!persisted || persisted.status !== status
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
  const normalizedInputs = inputs.map((input) => {
    if (!isAttendanceDate(input.date)) throw new Error("Attendance date must be a valid YYYY-MM-DD date");
    const status = canonicalAttendanceStatus(input.status);
    if (!status) throw new Error("Attendance status is invalid");
    return { ...input, status };
  });

  const activeMembers = members ?? await activeAttendanceMembers();
  const resolved = normalizedInputs.map((input) => ({
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

  return attendanceRepository.withBatchWriteTransaction({ memberIds, dates }, async ({
    existingRows,
    persistAndVerify,
  }) => {
    type State = { status: string; note: string | null; coaching: boolean };
    const states = new Map<string, State>(existingRows.map((row) => [
      `${row.memberId}:${row.date}`,
      { status: row.status, note: row.note, coaching: row.coaching },
    ]));
    const writes = new Map<string, AttendanceRecordWrite>();
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
        note: attendanceNoteForWrite(input.note, previous?.note ?? null),
        coaching: input.coaching ?? previous?.coaching ?? false,
      };
      states.set(key, next);
      writes.set(key, { memberId: member.id, date: input.date, dateValue: input.date, ...next, updatedAt });
      results.push({
        kind: "saved",
        action: existedBeforeInput ? "updated" : "created",
        member,
      });
    }

    await persistAndVerify(writes);

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
  if (previous.note === input.note) {
    return { kind: "saved", action: "unchanged", member: resolved.member, previous, record: previous };
  }

  // Historical deployments accepted free-text statuses. Notes must remain
  // editable even when a legacy status cannot be canonicalized yet; updating
  // only the note preserves that original value byte-for-byte.
  await attendanceRepository.updateRecordNote(previous.id, input.note);
  const persisted = await getAttendanceRecord(resolved.member.id, input.date);
  if (!persisted || persisted.note !== input.note || persisted.status !== previous.status) {
    throw new Error("Attendance note persistence verification failed");
  }
  return { kind: "saved", action: "updated", member: resolved.member, previous, record: persisted };
}
