import {
  addAttendanceCalendarDays,
  attendanceDate,
  attendanceStartOfDay,
} from "../../lib/attendancePolicy.js";
import { attendanceShiftStart, parseBusinessTimestampCompatibility } from "../../lib/businessTime.js";
import { buildQuoFirstCallMap } from "../../lib/databasePerformance.js";
import {
  authorizationAgent,
  canAccessLiveAgent,
  loadAuthorizationAgentDirectory,
} from "../../lib/authorizationScope.js";
import {
  canAccessDateRange,
  isAdministrator,
  isCanonicalUser,
  normalizeAgentIdentity,
} from "../../middleware/authorizationCore.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import { canAccessAttendanceMember } from "./attendance.authorization.js";
import {
  lateNote,
  pacificDisplayTime,
  resolveFirstCall,
} from "./attendance.calculations.js";
import {
  loadAttendancePbxCallHistory,
  type AttendancePbxFirstCall,
} from "./attendance.pbx.source.js";
import {
  attendanceRepository,
  type AttendanceRecordInsert,
} from "./attendance.repository.js";
import { AttendanceServiceError } from "./attendance.service.js";

type CallsRepository = Pick<typeof attendanceRepository,
  | "listFirstQuoCalls"
  | "listMembers"
  | "listRecordsForDate"
  | "listRecordedMemberIds"
  | "insertRecordsIfMissing"
  | "listAgentContactCalls"
>;

export interface AttendanceCallsServiceDependencies {
  repository: CallsRepository;
  loadDirectory: typeof loadAuthorizationAgentDirectory;
  loadPbxCallHistory: () => Promise<AttendancePbxFirstCall[]>;
  now: () => Date;
  today: () => string;
}

function forbidden(): never {
  throw new AttendanceServiceError(403, { error: "Forbidden" });
}

function dayWindow(date: string): { start: Date; end: Date } {
  const start = attendanceStartOfDay(date);
  const end = new Date(attendanceStartOfDay(addAttendanceCalendarDays(date, 1)).getTime() - 1);
  return { start, end };
}

export class AttendanceCallsService {
  constructor(private readonly dependencies: AttendanceCallsServiceDependencies) {}

  private async firstCallMaps(date: string, isToday: boolean) {
    const window = dayWindow(date);
    const pbxFirstCalls = new Map<string, Date>();
    if (isToday) {
      for (const stat of await this.dependencies.loadPbxCallHistory()) {
        if (!stat.firstCallAt) continue;
        const instant = parseBusinessTimestampCompatibility(stat.firstCallAt);
        if (instant < window.start || instant > window.end) continue;
        const key = stat.agentName.trim().toLowerCase();
        const existing = pbxFirstCalls.get(key);
        if (!existing || instant < existing) pbxFirstCalls.set(key, instant);
      }
    }
    const quoFirstCalls = buildQuoFirstCallMap(
      await this.dependencies.repository.listFirstQuoCalls(window.start, window.end),
    );
    return { window, pbxFirstCalls, quoFirstCalls };
  }

  async getCallLogs(input: { actor: AuthPayload; date: string }) {
    if (!canAccessDateRange(input.actor, [input.date])) forbidden();
    const now = this.dependencies.now();
    const sources = await this.firstCallMaps(input.date, input.date === this.dependencies.today());
    const directory = await this.dependencies.loadDirectory();
    const members = (await this.dependencies.repository.listMembers({ includeInactive: false, order: "department" }))
      .filter((member) => canAccessAttendanceMember(input.actor, member, directory));
    const existingRecords = await this.dependencies.repository.listRecordsForDate(
      members.map((member) => member.id),
      input.date,
    );
    const existingMap = new Map(existingRecords.map((record) => [record.memberId, record]));
    const agents = members.map((member) => {
      const shiftNum = parseInt(member.shift || "0");
      const shiftStartUtc = shiftNum ? attendanceShiftStart(input.date, shiftNum) : null;
      const firstCallAt = resolveFirstCall(
        member,
        sources.window.start,
        shiftStartUtc,
        sources.pbxFirstCalls,
        sources.quoFirstCalls,
      );
      const minsLate = firstCallAt && shiftStartUtc
        ? Math.round((firstCallAt.getTime() - shiftStartUtc.getTime()) / 60_000)
        : null;
      let autoStatus: string;
      if (!shiftNum) autoStatus = "no_shift";
      else if (firstCallAt === null) autoStatus = shiftStartUtc && now > shiftStartUtc ? "no_calls" : "shift_not_started";
      else autoStatus = (minsLate ?? 0) <= 10 ? "on_time" : "late";
      const existingRecord = existingMap.get(member.id) ?? null;
      return {
        memberId: member.id,
        memberName: member.name,
        department: member.department,
        shift: member.shift,
        shiftStartLA: shiftStartUtc?.toISOString() ?? null,
        firstCallAt: firstCallAt?.toISOString() ?? null,
        minsLate,
        autoStatus,
        existingRecord: existingRecord
          ? { status: existingRecord.status, note: existingRecord.note ?? "", coaching: existingRecord.coaching }
          : null,
      };
    });
    return { date: input.date, agents };
  }

  async autoMark(input: { actor: AuthPayload; date: string }) {
    if (!canAccessDateRange(input.actor, [input.date])) forbidden();
    const now = this.dependencies.now();
    const isToday = input.date === this.dependencies.today();
    const sources = await this.firstCallMaps(input.date, isToday);
    const directory = await this.dependencies.loadDirectory();
    const members = (await this.dependencies.repository.listMembers({ includeInactive: false, order: "name" }))
      .filter((member) => canAccessAttendanceMember(input.actor, member, directory));
    const existingSet = new Set(await this.dependencies.repository.listRecordedMemberIds(input.date));
    const results: Array<{ name: string; status: string; note: string; skipped?: string }> = [];
    const pending: AttendanceRecordInsert[] = [];
    for (const member of members) {
      const shiftNum = parseInt(member.shift || "0");
      if (!shiftNum) {
        results.push({ name: member.name, status: "", note: "", skipped: "no shift" });
        continue;
      }
      const shiftStartUtc = attendanceShiftStart(input.date, shiftNum);
      if (!shiftStartUtc) {
        results.push({ name: member.name, status: "", note: "", skipped: "invalid shift" });
        continue;
      }
      if (isToday && now < shiftStartUtc) {
        results.push({ name: member.name, status: "", note: "", skipped: "shift not started yet" });
        continue;
      }
      if (existingSet.has(member.id)) {
        results.push({ name: member.name, status: "", note: "", skipped: "already has record" });
        continue;
      }
      const firstCallAt = resolveFirstCall(
        member,
        sources.window.start,
        shiftStartUtc,
        sources.pbxFirstCalls,
        sources.quoFirstCalls,
      );
      if (!firstCallAt) {
        results.push({ name: member.name, status: "", note: "", skipped: "no calls found" });
        continue;
      }
      const minsLate = Math.round((firstCallAt.getTime() - shiftStartUtc.getTime()) / 60_000);
      const status = minsLate <= 10 ? "in" : "late";
      const note = minsLate <= 10 ? "" : lateNote(minsLate);
      pending.push({
        memberId: member.id,
        date: input.date,
        dateValue: input.date,
        status,
        note: note || null,
        coaching: false,
      });
      results.push({ name: member.name, status, note });
    }
    await this.dependencies.repository.insertRecordsIfMissing(pending);
    return { success: true, date: input.date, results };
  }

  async getAgentContacts(input: { actor: AuthPayload; agent: string; date: string }) {
    const authorizationDate = input.date || this.dependencies.today();
    if (!canAccessDateRange(input.actor, [authorizationDate])) forbidden();
    const directory = await this.dependencies.loadDirectory();
    if (!isAdministrator(input.actor)) {
      const requestedIdentity = normalizeAgentIdentity(input.agent);
      const exactAgent = authorizationAgent(directory, input.agent);
      const matchingAgents = isCanonicalUser(input.actor)
        ? exactAgent ? [exactAgent] : []
        : directory.agents.filter((agent) =>
            normalizeAgentIdentity(agent.name).includes(requestedIdentity)
            || (!!agent.arabicName && normalizeAgentIdentity(agent.arabicName).includes(requestedIdentity)));
      if (!matchingAgents.some((agent) => canAccessLiveAgent(input.actor, agent.name, directory))) forbidden();
    }

    const now = this.dependencies.now();
    const window = input.date
      ? { ...dayWindow(input.date), date: input.date }
      : {
          start: new Date(now.getTime() - 24 * 3_600_000),
          end: now,
          date: now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
        };
    const matchingRows = await this.dependencies.repository.listAgentContactCalls(input.agent, window.start, window.end);
    const rows = matchingRows.filter((row) => !!row.agentName && canAccessLiveAgent(input.actor, row.agentName, directory));
    const contactMap = new Map<string, {
      participant: string;
      calls: number;
      answered: number;
      missed: number;
      totalSeconds: number;
      inbound: number;
      outbound: number;
      firstCallAt: Date;
      lastCallAt: Date;
    }>();
    for (const row of rows) {
      let entry = contactMap.get(row.participant);
      if (!entry) {
        entry = {
          participant: row.participant,
          calls: 0,
          answered: 0,
          missed: 0,
          totalSeconds: 0,
          inbound: 0,
          outbound: 0,
          firstCallAt: row.createdAt,
          lastCallAt: row.createdAt,
        };
        contactMap.set(row.participant, entry);
      }
      entry.calls += 1;
      entry.totalSeconds += row.durationSeconds ?? 0;
      if (row.status === "completed") entry.answered += 1;
      else entry.missed += 1;
      if (row.direction === "incoming") entry.inbound += 1;
      else entry.outbound += 1;
      if (row.createdAt < entry.firstCallAt) entry.firstCallAt = row.createdAt;
      if (row.createdAt > entry.lastCallAt) entry.lastCallAt = row.createdAt;
    }
    const contacts = [...contactMap.values()]
      .sort((left, right) => right.calls - left.calls)
      .map((contact) => ({
        ...contact,
        firstCallAt: pacificDisplayTime(contact.firstCallAt),
        lastCallAt: pacificDisplayTime(contact.lastCallAt),
      }));
    return {
      agentQuery: input.agent,
      agentsMatched: [...new Set(rows.map((row) => row.agentName).filter(Boolean))],
      date: window.date,
      windowStart: pacificDisplayTime(window.start),
      windowEnd: pacificDisplayTime(window.end),
      totalCalls: rows.length,
      uniqueContacts: contacts.length,
      contacts,
    };
  }
}

export const attendanceCallsService = new AttendanceCallsService({
  repository: attendanceRepository,
  loadDirectory: loadAuthorizationAgentDirectory,
  loadPbxCallHistory: loadAttendancePbxCallHistory,
  now: () => new Date(),
  today: () => attendanceDate(),
});
