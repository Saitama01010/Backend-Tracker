import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import {
  AttendanceService,
  AttendanceServiceError,
  type AttendanceServiceDependencies,
} from "./attendance.service.js";

const actor: AuthPayload = {
  userId: 401,
  username: "sanitized-attendance-manager",
  role: "edit",
  permissions: ["view_attendance", "edit_attendance", "manage_members"],
  teamAccess: "retention",
  allowedAgents: null,
};

const createdAt = new Date("2026-08-16T10:00:00.000Z");
const updatedAt = new Date("2026-08-16T11:00:00.000Z");
const retentionMember = {
  id: 11,
  name: "Agent Alpha",
  shift: "4",
  shiftHours: "8",
  department: "Retention",
  active: true,
  createdAt,
};
const csMember = { ...retentionMember, id: 12, name: "Agent Beta", department: "CS" };
const attendanceRecord = {
  id: 101,
  memberId: retentionMember.id,
  date: "2026-08-16",
  status: "in",
  note: null,
  coaching: false,
  updatedAt,
};

function dependencies(overrides: Partial<AttendanceServiceDependencies> = {}) {
  let providerCalls = 0;
  let writeCalls = 0;
  let rangeMemberIds: readonly number[] = [];
  const value: AttendanceServiceDependencies = {
    repository: {
      async listMembers() { return [retentionMember, csMember]; },
      async listRecordsInRange(memberIds) {
        rangeMemberIds = memberIds;
        return [attendanceRecord];
      },
      async createMember() { return retentionMember; },
      async findMemberById() { return retentionMember; },
      async updateMember() { return retentionMember; },
      async persistImport() { return 1; },
    },
    async loadDirectory() {
      return createAuthorizationAgentDirectory([
        { id: 11, name: "Agent Alpha", arabicName: null, team: "retention", active: true },
        { id: 12, name: "Agent Beta", arabicName: null, team: "cs", active: true },
      ]);
    },
    async activeMembers() { return [retentionMember, csMember]; },
    async resolveActiveMember() { return { kind: "unique", member: retentionMember }; },
    resolveActiveMemberFromList(members, memberId, memberName) {
      const member = members.find((candidate) => candidate.id === memberId || candidate.name === memberName);
      return member ? { kind: "unique", member } : { kind: "missing" };
    },
    async writeRecord() {
      writeCalls += 1;
      return { kind: "saved", action: "created", member: retentionMember, previous: null, record: attendanceRecord };
    },
    async writeRecords(inputs) {
      writeCalls += 1;
      return inputs.map(() => ({ kind: "saved" as const, action: "created" as const, member: retentionMember }));
    },
    async loadImportCandidates() {
      providerCalls += 1;
      return [{
        name: retentionMember.name,
        shift: retentionMember.shift,
        department: retentionMember.department,
        records: [{ date: "2026-08-16", status: "in" }],
      }];
    },
    ...overrides,
  };
  return {
    value,
    providerCalls: () => providerCalls,
    writeCalls: () => writeCalls,
    rangeMemberIds: () => rangeMemberIds,
  };
}

test("Attendance dashboard scopes members before loading their records", async () => {
  const fake = dependencies();
  const result = await new AttendanceService(fake.value).getDashboard({
    actor,
    from: "2026-08-01",
    to: "2026-08-16",
    includeInactive: false,
  });

  assert.deepEqual(result.members.map((member) => member.name), ["Agent Alpha"]);
  assert.deepEqual(fake.rangeMemberIds(), [retentionMember.id]);
  assert.deepEqual(result.records, [attendanceRecord]);
  assert.equal(result.timezone, "America/Los_Angeles");
});

test("Attendance import rejects scoped actors before provider or database work", async () => {
  const fake = dependencies();
  const service = new AttendanceService(fake.value);

  await assert.rejects(
    service.importAttendance({ ...actor, allowedAgents: ["Agent Alpha"] }),
    (error: unknown) => error instanceof AttendanceServiceError
      && error.status === 403
      && error.payload.reason === "The attendance import spans multiple departments.",
  );
  assert.equal(fake.providerCalls(), 0);
});

test("Attendance bulk writes reject an out-of-scope member before persistence", async () => {
  const fake = dependencies();
  const service = new AttendanceService(fake.value);

  await assert.rejects(
    service.setRecords({
      actor,
      batch: {
        force: false,
        records: [{ memberId: csMember.id, date: "2026-08-16", status: "in" }],
      },
    }),
    (error: unknown) => error instanceof AttendanceServiceError && error.status === 403,
  );
  assert.equal(fake.writeCalls(), 0);
});

test("Attendance record writes preserve the existing response object", async () => {
  const fake = dependencies();
  const result = await new AttendanceService(fake.value).updateRecord({
    actor,
    record: { memberId: retentionMember.id, date: "2026-08-16", status: "in" },
  });

  assert.deepEqual(result, attendanceRecord);
  assert.equal(fake.writeCalls(), 1);
});
