import { attendanceShiftStart } from "../../lib/businessTime.js";
import { attendanceStartOfDay } from "../../lib/attendancePolicy.js";
import type {
  PbxMissedViolationRow,
  QuoMissedViolationRow,
  ViolationCallRow,
  ViolationMember,
} from "./violations.repository.js";

const LA_TIME_ZONE = "America/Los_Angeles";
const INPROGRESS_FALLBACK_S = 3 * 3600;
const MISSED_GRACE_MS = 2 * 3600 * 1000;

export type ViolationCallSource = "quo" | "pbx";
export type PbxCallSpans = ReadonlyMap<string, readonly { start: number; end: number }[]>;
export type PbxCallTimestamps = ReadonlyMap<string, readonly { at: string; source: "pbx"; id: string }[]>;

export interface LateLoginViolation {
  key: string;
  member: string;
  department: string;
  date: string;
  shiftStart: string;
  firstCallAt: string;
  minutesLate: number;
}

export interface AvailabilityGapViolation {
  key: string;
  member: string;
  department: string;
  date: string;
  gapCount: number;
  gaps: Array<{
    start: string;
    end: string;
    minutes: number;
    source: "quo" | "pbx" | "combined";
  }>;
}

export interface MissedWhileAvailableViolation {
  key: string;
  pbxCallId: number | null;
  source: "pbx" | "quo";
  date: string;
  missedAt: string;
  team: string;
  fromNumber: string;
  ringGroupName: string;
  availableAgents: string[];
  busyAgents: string[];
}

export interface ViolationsDashboardResult {
  lateLogin: LateLoginViolation[];
  availabilityGaps: AvailabilityGapViolation[];
  missedWhileAvail: MissedWhileAvailableViolation[];
  verifiedKeys: string[];
}

export interface CalculateViolationsInput {
  dates: readonly string[];
  rangeStart: Date;
  rangeEnd: Date;
  nowUtc: Date;
  members: readonly ViolationMember[];
  verifiedKeys: readonly string[];
  callRows: readonly ViolationCallRow[];
  missedRows: readonly PbxMissedViolationRow[];
  quoMissedRows: readonly QuoMissedViolationRow[];
  pbxCallSpans: PbxCallSpans;
  pbxCallTimestamps: PbxCallTimestamps;
  agentNamesForMember(name: string): readonly string[];
}

type AgentCallEvent = { at: Date; source: ViolationCallSource; id: string };

function calendarDate(value: Date): string {
  return value.toLocaleDateString("en-CA", { timeZone: LA_TIME_ZONE });
}

export function calculateViolations(input: CalculateViolationsInput): ViolationsDashboardResult {
  const allAgentLower = new Set<string>();
  for (const member of input.members) {
    for (const name of input.agentNamesForMember(member.name)) allAgentLower.add(name.toLowerCase());
  }

  const callsByAgentDate = new Map<string, AgentCallEvent[]>();
  const agentCallSpans = new Map<string, { start: number; end: number }[]>();

  for (const row of input.callRows) {
    if (!row.agentName || !row.createdAt) continue;
    const lower = row.agentName.trim().toLowerCase();
    if (!allAgentLower.has(lower)) continue;
    if (row.direction === "incoming") {
      const ringDuration = row.ringDurationSeconds ?? ((row.durationSeconds ?? 0) === 0 ? 0 : 999);
      if (ringDuration <= 2) continue;
    }
    const at = new Date(row.createdAt);
    const dateKey = `${lower}|${calendarDate(at)}`;
    const dateEvents = callsByAgentDate.get(dateKey) ?? [];
    dateEvents.push({ at, source: "quo", id: `quo:${lower}:${at.toISOString()}` });
    callsByAgentDate.set(dateKey, dateEvents);

    const duration = row.durationSeconds && row.durationSeconds > 0
      ? row.durationSeconds
      : (row.status === "in-progress" ? INPROGRESS_FALLBACK_S : 0);
    const spanStart = at.getTime();
    const spanEnd = spanStart + duration * 1000;
    if (spanEnd > spanStart) {
      const spans = agentCallSpans.get(lower) ?? [];
      spans.push({ start: spanStart, end: spanEnd });
      agentCallSpans.set(lower, spans);
    }
  }

  for (const [agentLower, events] of input.pbxCallTimestamps.entries()) {
    if (!allAgentLower.has(agentLower)) continue;
    for (const event of events) {
      const at = new Date(event.at);
      if (at < input.rangeStart || at > input.rangeEnd) continue;
      const dateKey = `${agentLower}|${calendarDate(at)}`;
      const dateEvents = callsByAgentDate.get(dateKey) ?? [];
      dateEvents.push({ at, source: "pbx", id: event.id });
      callsByAgentDate.set(dateKey, dateEvents);
    }
  }

  for (const [key, events] of callsByAgentDate) {
    const seen = new Set<string>();
    const deduped: AgentCallEvent[] = [];
    for (const event of events.sort((left, right) => left.at.getTime() - right.at.getTime())) {
      const dedupeKey = String(Math.floor(event.at.getTime() / 1000));
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      deduped.push(event);
    }
    callsByAgentDate.set(key, deduped);
  }

  function isAgentBusy(agentLower: string, atMs: number): boolean {
    if ((agentCallSpans.get(agentLower) ?? []).some((span) => span.start <= atMs && span.end >= atMs)) return true;
    return (input.pbxCallSpans.get(agentLower) ?? [])
      .some((span) => span.start <= atMs && span.end >= atMs);
  }

  const lateLogin: LateLoginViolation[] = [];
  const availabilityGaps: AvailabilityGapViolation[] = [];

  for (const date of input.dates) {
    const dayStart = attendanceStartOfDay(date);
    for (const member of input.members) {
      const shiftNumber = parseInt(member.shift || "0");
      if (!shiftNumber) continue;
      const shiftStartUtc = attendanceShiftStart(date, shiftNumber);
      if (!shiftStartUtc || shiftStartUtc > input.nowUtc) continue;

      const allCalls: AgentCallEvent[] = [];
      for (const name of input.agentNamesForMember(member.name)) {
        for (const event of callsByAgentDate.get(`${name.toLowerCase()}|${date}`) ?? []) allCalls.push(event);
      }
      allCalls.sort((left, right) => left.at.getTime() - right.at.getTime());

      const firstCall = allCalls.find((event) => event.at >= dayStart) ?? null;
      if (firstCall) {
        const minutesLate = Math.round((firstCall.at.getTime() - shiftStartUtc.getTime()) / 60000);
        if (minutesLate > 10) {
          lateLogin.push({
            key: `late:${member.name}:${date}`,
            member: member.name,
            department: member.department,
            date,
            shiftStart: shiftStartUtc.toISOString(),
            firstCallAt: firstCall.at.toISOString(),
            minutesLate,
          });
        }
      }

      const shiftDurationHours = Math.max(1, parseInt(member.shiftHours || "8"));
      const shiftEndUtc = new Date(shiftStartUtc.getTime() + shiftDurationHours * 3600 * 1000);
      const shiftCalls = allCalls.filter((event) => event.at >= shiftStartUtc && event.at <= shiftEndUtc);
      if (shiftCalls.length >= 2) {
        const gaps: AvailabilityGapViolation["gaps"] = [];
        for (let index = 0; index < shiftCalls.length - 1; index++) {
          const previous = shiftCalls[index]!;
          const next = shiftCalls[index + 1]!;
          const minutes = Math.round((next.at.getTime() - previous.at.getTime()) / 60000);
          const source = previous.source === next.source ? previous.source : "combined";
          if (minutes > 5) gaps.push({
            start: previous.at.toISOString(),
            end: next.at.toISOString(),
            minutes,
            source,
          });
        }
        if (gaps.length > 0) {
          availabilityGaps.push({
            key: `gap:${member.name}:${date}`,
            member: member.name,
            department: member.department,
            date,
            gapCount: gaps.length,
            gaps,
          });
        }
      }
    }
  }

  const missedCutoffMs = input.nowUtc.getTime() - MISSED_GRACE_MS;
  const missedWhileAvail: MissedWhileAvailableViolation[] = [];

  for (const missed of input.missedRows) {
    const missedMs = new Date(missed.createdAt).getTime();
    if (missedMs > missedCutoffMs) continue;
    const missedDate = calendarDate(new Date(missed.createdAt));
    const availableAgents: string[] = [];
    const busyAgents: string[] = [];

    const teamMembers = input.members.filter((member) => member.department.toLowerCase() === missed.team);
    for (const member of teamMembers) {
      const shiftNumber = parseInt(member.shift || "0");
      if (!shiftNumber) continue;
      const shiftStartDate = attendanceShiftStart(missedDate, shiftNumber);
      if (!shiftStartDate) continue;
      const shiftStart = shiftStartDate.getTime();
      const shiftDurationHours = Math.max(1, parseInt(member.shiftHours || "8"));
      const shiftEnd = shiftStart + shiftDurationHours * 3600 * 1000;
      if (missedMs < shiftStart || missedMs > shiftEnd) continue;

      const busy = input.agentNamesForMember(member.name)
        .some((name) => isAgentBusy(name.toLowerCase(), missedMs));
      (busy ? busyAgents : availableAgents).push(member.name);
    }

    if (availableAgents.length > 0) {
      missedWhileAvail.push({
        key: `missed:${missed.id}`,
        pbxCallId: missed.id,
        source: "pbx",
        date: missedDate,
        missedAt: missed.createdAt.toISOString(),
        team: missed.team,
        fromNumber: missed.fromNumber,
        ringGroupName: missed.ringGroupName,
        availableAgents,
        busyAgents,
      });
    }
  }

  for (const missed of input.quoMissedRows) {
    const ringDuration = missed.ringDurationSeconds;
    const isGhost = ringDuration != null
      ? ringDuration <= 2
      : (missed.status === "no-answer" && (missed.durationSeconds ?? 0) === 0)
        || (missed.status === "voicemail" && (missed.durationSeconds ?? 0) === 0)
        || (missed.status === "voicemail-brief" && (missed.durationSeconds ?? 0) <= 4);
    if (isGhost) continue;

    const missedMs = new Date(missed.createdAt).getTime();
    if (missedMs > missedCutoffMs) continue;
    const missedDate = calendarDate(new Date(missed.createdAt));
    const availableAgents: string[] = [];
    const busyAgents: string[] = [];

    const teamMembers = input.members.filter((member) => member.department.toLowerCase() === missed.lineTeam);
    for (const member of teamMembers) {
      const shiftNumber = parseInt(member.shift || "0");
      if (!shiftNumber) continue;
      const shiftStartDate = attendanceShiftStart(missedDate, shiftNumber);
      if (!shiftStartDate) continue;
      const shiftStart = shiftStartDate.getTime();
      const shiftDurationHours = Math.max(1, parseInt(member.shiftHours || "8"));
      const shiftEnd = shiftStart + shiftDurationHours * 3600 * 1000;
      if (missedMs < shiftStart || missedMs > shiftEnd) continue;

      const busy = input.agentNamesForMember(member.name)
        .some((name) => isAgentBusy(name.toLowerCase(), missedMs));
      (busy ? busyAgents : availableAgents).push(member.name);
    }

    if (availableAgents.length > 0) {
      missedWhileAvail.push({
        key: `quo-missed:${missed.id}`,
        pbxCallId: null,
        source: "quo",
        date: missedDate,
        missedAt: new Date(missed.createdAt).toISOString(),
        team: missed.lineTeam,
        fromNumber: missed.participant,
        ringGroupName: missed.lineName,
        availableAgents,
        busyAgents,
      });
    }
  }

  missedWhileAvail.sort((left, right) => right.missedAt.localeCompare(left.missedAt));
  return {
    lateLogin,
    availabilityGaps,
    missedWhileAvail,
    verifiedKeys: [...input.verifiedKeys],
  };
}
