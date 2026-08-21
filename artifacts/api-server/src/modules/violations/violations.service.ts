import {
  ATTENDANCE_MEMBER_ALIASES,
  addAttendanceCalendarDays,
  attendanceDate,
  attendanceStartOfDay,
} from "../../lib/attendancePolicy.js";
import {
  canAccessMetricAgent,
  loadAuthorizationAgentDirectory,
  type AuthorizationAgentDirectory,
} from "../../lib/authorizationScope.js";
import {
  parseViolationVerificationPayload,
  validateOptionalWorkflowRange,
  violationVerificationKeyMatchesPayload,
} from "../../lib/sensitiveWorkflowPolicy.js";
import {
  canAccessAttendanceDepartment,
  canAccessDateRange,
} from "../../middleware/authorizationCore.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import {
  hydratePbxState,
  vosCallSpansCache,
  vosCallTimestampsCache,
} from "../pbx/pbx.state.js";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import {
  calculateViolations,
  type PbxCallSpans,
  type PbxCallTimestamps,
  type ViolationsDashboardResult,
} from "./violations.calculations.js";
import {
  violationsRepository,
  type ViolationsRepository,
} from "./violations.repository.js";
import type { ViolationsQueryInput } from "./violations.schemas.js";

const TEAM_QUO_LINES = [...OPERATIONAL_CONFIG.trackedTeamLines];

export class ViolationsServiceError extends Error {
  constructor(
    readonly status: 400 | 403,
    readonly response: { error: string },
  ) {
    super(response.error);
  }
}

export function agentNamesForViolationMember(name: string): readonly string[] {
  return ATTENDANCE_MEMBER_ALIASES[name] ?? [name];
}

export function canAccessViolationIdentity(
  actor: AuthPayload,
  member: string,
  department: string,
  directory: AuthorizationAgentDirectory,
): boolean {
  return canAccessAttendanceDepartment(actor, department)
    && [member, ...agentNamesForViolationMember(member)]
      .some((name) => canAccessMetricAgent(actor, name, directory));
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let current = from; current <= to; current = addAttendanceCalendarDays(current, 1)) dates.push(current);
  return dates;
}

export interface ViolationsServiceDependencies {
  repository: ViolationsRepository;
  hydratePbxState(): Promise<void>;
  pbxCallSpans: PbxCallSpans;
  pbxCallTimestamps: PbxCallTimestamps;
  loadAuthorizationDirectory(): Promise<AuthorizationAgentDirectory>;
  now(): Date;
}

const defaultDependencies: ViolationsServiceDependencies = {
  repository: violationsRepository,
  hydratePbxState,
  pbxCallSpans: vosCallSpansCache,
  pbxCallTimestamps: vosCallTimestampsCache,
  loadAuthorizationDirectory: loadAuthorizationAgentDirectory,
  now: () => new Date(),
};

export class ViolationsService {
  constructor(private readonly dependencies: ViolationsServiceDependencies = defaultDependencies) {}

  async getDashboard(input: {
    actor: AuthPayload;
    query: ViolationsQueryInput;
  }): Promise<ViolationsDashboardResult> {
    await this.dependencies.hydratePbxState();
    const today = attendanceDate();
    const rawFrom = input.query.from || addAttendanceCalendarDays(today, -7);
    const rawTo = input.query.to || today;
    const requestedRange = validateOptionalWorkflowRange(rawFrom, rawTo);
    if (!requestedRange.ok) throw new ViolationsServiceError(400, { error: requestedRange.error });
    const from = rawFrom as string;
    const to = rawTo as string;
    const dates = dateRange(from, to).filter((date) => date <= today);
    if (dates.length === 0) {
      return { lateLogin: [], availabilityGaps: [], missedWhileAvail: [], verifiedKeys: [] };
    }

    const rangeStart = attendanceStartOfDay(dates[0]!);
    const rangeEnd = new Date(
      attendanceStartOfDay(addAttendanceCalendarDays(dates[dates.length - 1]!, 1)).getTime() - 1,
    );
    const [data, directory] = await Promise.all([
      this.dependencies.repository.loadDashboardData(rangeStart, rangeEnd, TEAM_QUO_LINES),
      this.dependencies.loadAuthorizationDirectory(),
    ]);
    const members = data.members.filter((member) => canAccessViolationIdentity(
      input.actor,
      member.name,
      member.department,
      directory,
    ));
    const verifiedKeys = data.verifications
      .filter((verification) => canAccessViolationIdentity(
        input.actor,
        verification.member,
        verification.department,
        directory,
      ))
      .map((verification) => verification.key);

    return calculateViolations({
      dates,
      rangeStart,
      rangeEnd,
      nowUtc: this.dependencies.now(),
      members,
      verifiedKeys,
      callRows: data.callRows,
      missedRows: data.missedRows,
      quoMissedRows: data.quoMissedRows,
      pbxCallSpans: this.dependencies.pbxCallSpans,
      pbxCallTimestamps: this.dependencies.pbxCallTimestamps,
      agentNamesForMember: agentNamesForViolationMember,
    });
  }

  async verify(input: { actor: AuthPayload; body: unknown }): Promise<{ ok: true }> {
    const payload = parseViolationVerificationPayload(input.body, input.actor.username);
    if (!payload || !violationVerificationKeyMatchesPayload(
      payload,
      agentNamesForViolationMember(payload.member),
    )) {
      throw new ViolationsServiceError(400, { error: "Invalid violation verification." });
    }
    const missedScope = payload.type === "missed_call"
      ? await this.dependencies.repository.resolveMissedVerificationScope(payload.key, TEAM_QUO_LINES)
      : null;
    if (payload.type === "missed_call" && (!missedScope
      || missedScope.department !== payload.department.toLowerCase()
      || missedScope.date !== payload.date)) {
      throw new ViolationsServiceError(400, { error: "Invalid violation verification." });
    }
    const authorizedDepartment = missedScope?.department ?? payload.department;
    const authorizedDate = missedScope?.date ?? payload.date;
    if (!canAccessDateRange(input.actor, [authorizedDate])) {
      throw new ViolationsServiceError(403, { error: "Forbidden" });
    }
    const directory = await this.dependencies.loadAuthorizationDirectory();
    if (!canAccessViolationIdentity(input.actor, payload.member, authorizedDepartment, directory)) {
      throw new ViolationsServiceError(403, { error: "Forbidden" });
    }
    await this.dependencies.repository.saveVerification({
      ...payload,
      verifiedBy: input.actor.username,
    });
    return { ok: true };
  }

  async removeVerification(body: unknown): Promise<{ ok: true }> {
    const { key } = body as { key: string };
    if (typeof key !== "string" || !key.trim() || key.length > 512) {
      throw new ViolationsServiceError(400, { error: "key required" });
    }
    await this.dependencies.repository.deleteVerification(key);
    return { ok: true };
  }

  async listVerified(actor: AuthPayload) {
    const rows = await this.dependencies.repository.listVerifications();
    const directory = await this.dependencies.loadAuthorizationDirectory();
    return {
      items: rows.filter((row) => canAccessViolationIdentity(
        actor,
        row.member,
        row.department,
        directory,
      )),
    };
  }
}

export const violationsService = new ViolationsService();
