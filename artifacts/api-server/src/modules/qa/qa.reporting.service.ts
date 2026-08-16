import type { AuthPayload } from "../../middleware/authCore.js";
import type { QaDateBasis } from "../../lib/qaPolicy.js";
import { authorizeQaDepartments, resolveQaAgentScope, type QaAgentScope } from "./qa.authorization.js";
import {
  QaRepository,
  qaRepository,
  type QaManagerTaskRecord,
  type QaReviewRecord,
} from "./qa.repository.js";
import { parseQaDepartment, type QaDepartment, type QaTaskResolutionInput } from "./qa.schemas.js";

export class QaReportingError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly response: { error: string },
  ) {
    super(response.error);
  }
}

export type QaReportingRangeInput = {
  from: Date;
  to: Date;
  dateBasis: QaDateBasis;
  departments: QaDepartment[] | null;
  agentScope: QaAgentScope;
};

type QaReportingRepository = Pick<QaRepository,
  | "listStatsReviews"
  | "listStatsTasks"
  | "listReviews"
  | "getReview"
  | "listManagerTasks"
  | "getManagerTask"
  | "resolveManagerTask"
  | "listAgentStats"
>;

export class QaReportingService {
  constructor(private readonly repository: QaReportingRepository = qaRepository) {}

  async getStats(input: QaReportingRangeInput) {
    const queriedRows = await this.repository.listStatsReviews({
      from: input.from,
      to: input.to,
      dateBasis: input.dateBasis,
      departments: input.departments,
      authorizedIdentities: input.agentScope.authorizedIdentities,
    });
    const rows = queriedRows.filter((row) => input.agentScope.canAccess(row.agentName));
    const reviewed = rows.length;
    const avgScore = reviewed ? Math.round(rows.reduce((a, row) => a + row.score, 0) / reviewed) : 0;
    const avgProtocol = reviewed
      ? Math.round(rows.reduce((a, row) => a + (row.protocolScore || 0), 0) / reviewed)
      : 0;
    const avgSoftSkills = reviewed
      ? Math.round(rows.reduce((a, row) => a + (row.softSkillsScore || 0), 0) / reviewed)
      : 0;
    const failed = rows.filter((row) => !row.pass).length;
    const criticalFails = rows.filter((row) => row.criticalFail).length;

    const byDept: Record<string, {
      reviewed: number;
      avgScore: number;
      criticalFails: number;
      failed: number;
      taxMentions: number;
    }> = {};
    for (const row of rows) {
      const department = row.department || "Unknown";
      if (!byDept[department]) {
        byDept[department] = { reviewed: 0, avgScore: 0, criticalFails: 0, failed: 0, taxMentions: 0 };
      }
      byDept[department].reviewed++;
      byDept[department].avgScore += row.score;
      if (row.criticalFail) byDept[department].criticalFails++;
      if (!row.pass) byDept[department].failed++;
      if (row.mentionsTax) byDept[department].taxMentions++;
    }
    for (const department of Object.keys(byDept)) {
      const breakdown = byDept[department];
      breakdown.avgScore = breakdown.reviewed ? Math.round(breakdown.avgScore / breakdown.reviewed) : 0;
    }

    const taxMentions = rows.filter((row) => row.mentionsTax).length;
    const queriedTasks = await this.repository.listStatsTasks({
      departments: input.departments,
      authorizedIdentities: input.agentScope.authorizedIdentities,
    });
    const tasks = queriedTasks.filter((task) => input.agentScope.canAccess(task.agentName));
    const openManagerQueue = tasks.filter((task) => task.status === "open").length;
    const managerTasksCreatedInRange = tasks.filter((task) =>
      task.createdAt >= input.from && task.createdAt <= input.to).length;
    const varianceRows = tasks.filter((task) => task.status === "resolved"
      && task.managerScore !== null
      && task.createdAt >= input.from
      && task.createdAt <= input.to);
    const avgVariance = varianceRows.length
      ? Math.round((varianceRows.reduce((a, row) => a + Math.abs(row.variance ?? 0), 0) / varianceRows.length) * 10) / 10
      : 0;

    return {
      reviewed,
      avgScore,
      avgProtocol,
      avgSoftSkills,
      failed,
      criticalFails,
      openManagerQueue,
      managerTasksCreatedInRange,
      avgVariance,
      taxMentions,
      byDept,
      dateBasis: input.dateBasis,
    };
  }

  async listReviews(input: QaReportingRangeInput & { agent: string; limit: number }): Promise<{
    reviews: QaReviewRecord[];
    dateBasis: QaDateBasis;
  }> {
    if (input.agent && !input.agentScope.canAccess(input.agent)) {
      throw new QaReportingError(403, { error: "Forbidden" });
    }
    const queriedRows = await this.repository.listReviews({
      from: input.from,
      to: input.to,
      dateBasis: input.dateBasis,
      departments: input.departments,
      authorizedIdentities: input.agentScope.authorizedIdentities,
      agent: input.agent,
      limit: input.limit,
    });
    return {
      reviews: queriedRows.filter((row) => input.agentScope.canAccess(row.agentName)),
      dateBasis: input.dateBasis,
    };
  }

  async getReview(input: {
    id: string;
    actor: AuthPayload;
    department: unknown;
  }): Promise<QaReviewRecord> {
    // Compatibility: the legacy route returns 404 before parsing department scope.
    const row = await this.repository.getReview(input.id);
    if (!row) throw new QaReportingError(404, { error: "not found" });
    const parsedDepartment = parseQaDepartment(input.department);
    if (!parsedDepartment.ok) throw new QaReportingError(400, { error: parsedDepartment.error });
    const departmentScope = authorizeQaDepartments(input.actor, parsedDepartment.requested);
    if (!departmentScope.ok) throw new QaReportingError(departmentScope.status, { error: departmentScope.error });
    if (departmentScope.departments
      && !departmentScope.departments.includes(row.department as QaDepartment)) {
      throw new QaReportingError(403, { error: "Forbidden" });
    }
    const agentScope = await resolveQaAgentScope(input.actor);
    if (!agentScope.canAccess(row.agentName)) throw new QaReportingError(403, { error: "Forbidden" });
    return row;
  }

  async listTasks(input: {
    statuses: string[];
    limit: number;
    departments: QaDepartment[] | null;
    agentScope: QaAgentScope;
  }): Promise<{ tasks: QaManagerTaskRecord[] }> {
    const queriedRows = await this.repository.listManagerTasks({
      statuses: input.statuses,
      limit: input.limit,
      departments: input.departments,
      authorizedIdentities: input.agentScope.authorizedIdentities,
    });
    return { tasks: queriedRows.filter((row) => input.agentScope.canAccess(row.agentName)) };
  }

  async resolveTask(input: {
    id: string;
    resolvedBy: string;
    resolution: QaTaskResolutionInput;
  }): Promise<QaManagerTaskRecord | null> {
    const existing = await this.repository.getManagerTask(input.id);
    if (!existing) throw new QaReportingError(404, { error: "not found" });
    const { managerScore } = input.resolution;
    const variance = managerScore !== null ? managerScore - existing.aiScore : null;
    const finalScore = managerScore !== null ? managerScore : existing.aiScore;
    return this.repository.resolveManagerTask(input.id, {
      resolvedBy: input.resolvedBy,
      notes: input.resolution.notes,
      comments: input.resolution.comments,
      managerScore,
      variance,
      finalScore,
      coachingComplete: input.resolution.coachingComplete,
    });
  }

  async listAgents(input: QaReportingRangeInput) {
    const queriedRows = await this.repository.listAgentStats({
      from: input.from,
      to: input.to,
      dateBasis: input.dateBasis,
      departments: input.departments,
      authorizedIdentities: input.agentScope.authorizedIdentities,
    });
    return {
      agents: queriedRows.filter((row) => input.agentScope.canAccess(row.agentName)),
      dateBasis: input.dateBasis,
    };
  }
}

export const qaReportingService = new QaReportingService();
