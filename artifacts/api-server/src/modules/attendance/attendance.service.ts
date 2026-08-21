import { ATTENDANCE_TIMEZONE } from "../../lib/attendancePolicy.js";
import {
  activeAttendanceMembers,
  resolveActiveAttendanceMember,
  resolveActiveAttendanceMemberFromList,
  setAttendanceRecord,
  setAttendanceRecords,
} from "../../lib/attendanceService.js";
import { buildAttendanceImportPlan } from "../../lib/databasePerformance.js";
import { loadAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import {
  attendanceDepartmentForUser,
  canAccessDateRange,
  hasPermission,
  isAdministrator,
  isCanonicalUser,
} from "../../middleware/authorizationCore.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import {
  AttendanceImportSourceError,
  loadAttendanceImportCandidates,
} from "../../integrations/googleSheets/attendanceImport.js";
import { canAccessAttendanceMember } from "./attendance.authorization.js";
import { attendanceRepository } from "./attendance.repository.js";
import type {
  AttendanceBatchInput,
  AttendanceMemberInput,
  AttendanceMemberPatch,
  AttendanceRecordInput,
} from "./attendance.types.js";

type CoreRepository = Pick<typeof attendanceRepository,
  | "listMembers"
  | "listRecordsInRange"
  | "createMember"
  | "findMemberById"
  | "updateMember"
  | "persistImport"
>;

export interface AttendanceServiceDependencies {
  repository: CoreRepository;
  loadDirectory: typeof loadAuthorizationAgentDirectory;
  activeMembers: typeof activeAttendanceMembers;
  resolveActiveMember: typeof resolveActiveAttendanceMember;
  resolveActiveMemberFromList: typeof resolveActiveAttendanceMemberFromList;
  writeRecord: typeof setAttendanceRecord;
  writeRecords: typeof setAttendanceRecords;
  loadImportCandidates: typeof loadAttendanceImportCandidates;
}

export class AttendanceServiceError extends Error {
  constructor(
    readonly status: number,
    readonly payload: { error: string; reason?: string },
  ) {
    super(payload.error);
  }
}

function fail(status: number, error: string, reason?: string): never {
  throw new AttendanceServiceError(status, reason ? { error, reason } : { error });
}

export class AttendanceService {
  constructor(private readonly dependencies: AttendanceServiceDependencies) {}

  async getDashboard(input: {
    actor: AuthPayload;
    from: string;
    to: string;
    includeInactive: boolean;
  }) {
    if (!canAccessDateRange(input.actor, [input.from, input.to])
      || (input.includeInactive && !hasPermission(input.actor, "manage_members"))) {
      fail(403, "Forbidden");
    }
    const allMembers = await this.dependencies.repository.listMembers({
      includeInactive: input.includeInactive,
      order: "department",
    });
    const directory = await this.dependencies.loadDirectory();
    const members = allMembers.filter((member) => canAccessAttendanceMember(input.actor, member, directory));
    const records = await this.dependencies.repository.listRecordsInRange(
      members.map((member) => member.id),
      input.from,
      input.to,
    );
    return { members, records, timezone: ATTENDANCE_TIMEZONE };
  }

  async createMember(input: { actor: AuthPayload; member: AttendanceMemberInput }) {
    const member = {
      name: input.member.name.trim(),
      shift: input.member.shift?.trim() ?? "",
      shiftHours: input.member.shiftHours?.trim() ?? "8",
      department: input.member.department?.trim() ?? "",
    };
    const directory = await this.dependencies.loadDirectory();
    if (!canAccessAttendanceMember(input.actor, member, directory)) fail(403, "Forbidden");
    return this.dependencies.repository.createMember(member);
  }

  async updateMember(input: { actor: AuthPayload; id: number; patch: AttendanceMemberPatch }) {
    const existing = await this.dependencies.repository.findMemberById(input.id);
    if (!existing) fail(404, "Attendance member not found");
    const finalDepartment = input.patch.department?.trim() ?? existing.department;
    const finalName = input.patch.name?.trim() ?? existing.name;
    const directory = await this.dependencies.loadDirectory();
    if (!canAccessAttendanceMember(input.actor, existing, directory)
      || !canAccessAttendanceMember(input.actor, { name: finalName, department: finalDepartment }, directory)) {
      fail(403, "Forbidden");
    }
    const patch: AttendanceMemberPatch = {};
    if (input.patch.name !== undefined) patch.name = input.patch.name.trim();
    if (input.patch.shift !== undefined) patch.shift = input.patch.shift.trim();
    if (input.patch.shiftHours !== undefined) patch.shiftHours = input.patch.shiftHours.trim();
    if (input.patch.department !== undefined) patch.department = input.patch.department.trim();
    if (input.patch.active !== undefined) patch.active = input.patch.active;
    return this.dependencies.repository.updateMember(input.id, patch);
  }

  async updateRecord(input: { actor: AuthPayload; record: AttendanceRecordInput }) {
    if (!canAccessDateRange(input.actor, [input.record.date])) fail(403, "Forbidden");
    const resolved = await this.dependencies.resolveActiveMember(input.record.memberId);
    if (resolved.kind === "missing") fail(404, "Attendance member not found");
    if (resolved.kind === "ambiguous") fail(409, "Attendance member is ambiguous");
    const directory = await this.dependencies.loadDirectory();
    if (!canAccessAttendanceMember(input.actor, resolved.member, directory)) fail(403, "Forbidden");
    const result = await this.dependencies.writeRecord({
      ...input.record,
      coaching: input.record.coaching ?? false,
      overwrite: true,
    });
    if (result.kind === "member_missing") fail(404, "Attendance member not found");
    if (result.kind === "member_ambiguous") fail(409, "Attendance member is ambiguous");
    if (result.kind === "conflict") fail(409, "Conflicting attendance record");
    return result.record;
  }

  async importAttendance(actor: AuthPayload) {
    if ((isCanonicalUser(actor) && !isAdministrator(actor))
      || attendanceDepartmentForUser(actor)
      || actor.allowedAgents?.length) {
      fail(403, "Forbidden", "The attendance import spans multiple departments.");
    }
    const importPlan = buildAttendanceImportPlan(await this.dependencies.loadImportCandidates());
    const totalMembers = await this.dependencies.repository.persistImport(importPlan.members);
    return { success: true, totalMembers, totalRecords: importPlan.totalRecords };
  }

  async setRecords(input: { actor: AuthPayload; batch: AttendanceBatchInput }) {
    if (!canAccessDateRange(input.actor, input.batch.records.map((record) => record.date))) fail(403, "Forbidden");
    const [members, directory] = await Promise.all([
      this.dependencies.activeMembers(),
      this.dependencies.loadDirectory(),
    ]);
    for (const record of input.batch.records) {
      const resolved = this.dependencies.resolveActiveMemberFromList(members, record.memberId, record.memberName);
      if (resolved.kind === "ambiguous") fail(409, "Attendance member is ambiguous");
      if (resolved.kind === "unique" && !canAccessAttendanceMember(input.actor, resolved.member, directory)) {
        fail(403, "Forbidden");
      }
    }

    const writeResults = await this.dependencies.writeRecords(input.batch.records.map((record) => ({
      ...record,
      overwrite: input.batch.force,
    })), members);
    const results: Array<{ memberName: string; date: string; status: string; action: string }> = [];
    for (let index = 0; index < input.batch.records.length; index++) {
      const record = input.batch.records[index]!;
      const result = writeResults[index]!;
      const requestedName = record.memberName ?? `member #${record.memberId ?? "unknown"}`;
      if (result.kind === "member_missing") {
        results.push({ memberName: requestedName, date: record.date, status: record.status, action: "skipped: member not found" });
      } else if (result.kind === "member_ambiguous") {
        fail(409, "Attendance member is ambiguous");
      } else if (result.kind === "conflict") {
        results.push({
          memberName: result.member.name,
          date: record.date,
          status: record.status,
          action: `skipped: already ${result.existing.status} (use force=true to overwrite)`,
        });
      } else {
        results.push({ memberName: result.member.name, date: record.date, status: record.status, action: result.action });
      }
    }
    return { success: true, results, timezone: ATTENDANCE_TIMEZONE };
  }
}

export { AttendanceImportSourceError };

export const attendanceService = new AttendanceService({
  repository: attendanceRepository,
  loadDirectory: loadAuthorizationAgentDirectory,
  activeMembers: activeAttendanceMembers,
  resolveActiveMember: resolveActiveAttendanceMember,
  resolveActiveMemberFromList: resolveActiveAttendanceMemberFromList,
  writeRecord: setAttendanceRecord,
  writeRecords: setAttendanceRecords,
  loadImportCandidates: loadAttendanceImportCandidates,
});
