import {
  db,
  managerQaTasksTable,
  phoneCallsTable,
  qaBiweeklyRunsTable,
  qaReviewsTable,
  teamAgentsTable,
} from "@workspace/db";
import { and, desc, eq, gt, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { QaDateBasis } from "../../lib/qaPolicy.js";
import type { QaDepartment } from "./qa.schemas.js";

export type QaReviewRecord = typeof qaReviewsTable.$inferSelect;
export type QaReviewWrite = typeof qaReviewsTable.$inferInsert;
export type QaManagerTaskRecord = typeof managerQaTasksTable.$inferSelect;
export type QaManagerTaskWrite = typeof managerQaTasksTable.$inferInsert;
export type QaPhoneCallRecord = typeof phoneCallsTable.$inferSelect;
export type QaBiweeklyRunRecord = typeof qaBiweeklyRunsTable.$inferSelect;

export type QaBiweeklyInputs = {
  roster: Array<typeof teamAgentsTable.$inferSelect>;
  recentReviews: Array<{ agentName: string }>;
  candidates: QaPhoneCallRecord[];
  reviewed: Array<{ id: string }>;
};

export type QaReportingScope = {
  departments: QaDepartment[] | null;
  authorizedIdentities: string[] | null;
};

export type QaReviewRange = QaReportingScope & {
  from: Date;
  to: Date;
  dateBasis: QaDateBasis;
};

const TAX_REGEX = String.raw`\ytax(es)?\y`;

function qaReviewDateColumn(dateBasis: QaDateBasis) {
  return dateBasis === "evaluated" ? qaReviewsTable.evaluatedAt : qaReviewsTable.callDate;
}

function identityPredicate(
  column: typeof qaReviewsTable.agentName | typeof managerQaTasksTable.agentName,
  authorizedIdentities: string[] | null,
): SQL | undefined {
  return authorizedIdentities === null
    ? undefined
    : inArray(
        sql<string>`regexp_replace(lower(trim(${column})), '[^a-z0-9]+', ' ', 'g')`,
        authorizedIdentities,
      );
}

function reviewFilters(input: QaReviewRange): SQL[] {
  const dateColumn = qaReviewDateColumn(input.dateBasis);
  const filters: SQL[] = [gte(dateColumn, input.from), lte(dateColumn, input.to)];
  if (input.departments) filters.push(inArray(qaReviewsTable.department, input.departments));
  const agentPredicate = identityPredicate(qaReviewsTable.agentName, input.authorizedIdentities);
  if (agentPredicate) filters.push(agentPredicate);
  return filters;
}

export type QaRunResultSnapshot = {
  runId: number;
  evaluated: Array<{ agent: string; callId: string }>;
  skipped: Array<{ agent: string; reason: string }>;
  errors: Array<{ agent: string; reason: string }>;
};

export class QaRepository {
  async getCall(callId: string): Promise<QaPhoneCallRecord | null> {
    const [call] = await db.select().from(phoneCallsTable)
      .where(eq(phoneCallsTable.id, callId))
      .limit(1);
    return call ?? null;
  }

  async getReview(callId: string): Promise<QaReviewRecord | null> {
    const [review] = await db.select().from(qaReviewsTable)
      .where(eq(qaReviewsTable.id, callId))
      .limit(1);
    return review ?? null;
  }

  async saveEvaluation(
    reviewRow: QaReviewWrite,
    managerTask: QaManagerTaskWrite | null,
  ): Promise<QaReviewRecord | null> {
    await db.insert(qaReviewsTable).values(reviewRow).onConflictDoUpdate({
      target: qaReviewsTable.id,
      set: {
        department: reviewRow.department,
        score: reviewRow.score,
        softSkillsScore: reviewRow.softSkillsScore,
        protocolScore: reviewRow.protocolScore,
        pass: reviewRow.pass,
        criticalFail: reviewRow.criticalFail,
        strengths: reviewRow.strengths,
        missedItems: reviewRow.missedItems,
        criticalIssues: reviewRow.criticalIssues,
        categoryScores: reviewRow.categoryScores,
        reason: reviewRow.reason,
        managerReviewRequired: reviewRow.managerReviewRequired,
        model: reviewRow.model,
        source: reviewRow.source,
        evaluatedAt: new Date(),
      },
    });

    if (managerTask) {
      await db.insert(managerQaTasksTable).values(managerTask).onConflictDoNothing();
    }

    return this.getReview(reviewRow.id);
  }

  async createBiweeklyRun(trigger: "cron" | "admin"): Promise<QaBiweeklyRunRecord | null> {
    const [run] = await db.insert(qaBiweeklyRunsTable).values({ trigger }).returning();
    return run ?? null;
  }

  async loadBiweeklyInputs(cutoff: Date, minimumSeconds: number): Promise<QaBiweeklyInputs> {
    const [roster, recentReviews, candidates, reviewed] = await Promise.all([
      db.select().from(teamAgentsTable).where(and(
        eq(teamAgentsTable.active, true),
        inArray(teamAgentsTable.team, ["retention", "cs", "nsf"]),
      )),
      db.select({ agentName: qaReviewsTable.agentName }).from(qaReviewsTable)
        .where(gt(qaReviewsTable.evaluatedAt, cutoff)),
      db.select().from(phoneCallsTable).where(and(
        gte(phoneCallsTable.createdAt, cutoff),
        eq(phoneCallsTable.status, "completed"),
        gte(phoneCallsTable.durationSeconds, minimumSeconds),
        inArray(phoneCallsTable.lineTeam, ["retention", "cs", "nsf"]),
      )),
      db.select({ id: qaReviewsTable.id }).from(qaReviewsTable)
        .where(gte(qaReviewsTable.callDate, cutoff)),
    ]);
    return { roster, recentReviews, candidates, reviewed };
  }

  async completeBiweeklyRun(runId: number, result: QaRunResultSnapshot): Promise<void> {
    await db.update(qaBiweeklyRunsTable).set({
      status: "completed",
      result: { ...result },
      finishedAt: new Date(),
    }).where(eq(qaBiweeklyRunsTable.id, runId));
  }

  async failBiweeklyRun(runId: number, result: QaRunResultSnapshot): Promise<void> {
    await db.update(qaBiweeklyRunsTable).set({
      status: "failed",
      result: { ...result },
      finishedAt: new Date(),
    }).where(eq(qaBiweeklyRunsTable.id, runId));
  }

  async listReviewsSince(lookback: Date): Promise<QaReviewRecord[]> {
    return db.select().from(qaReviewsTable).where(gte(qaReviewsTable.callDate, lookback));
  }

  async listManagerTasksForAgents(agentNames: string[]): Promise<Array<{
    id: string;
    agentName: string;
    source: string;
    createdAt: Date;
  }>> {
    if (agentNames.length === 0) return [];
    return db.select({
      id: managerQaTasksTable.id,
      agentName: managerQaTasksTable.agentName,
      source: managerQaTasksTable.source,
      createdAt: managerQaTasksTable.createdAt,
    }).from(managerQaTasksTable).where(inArray(managerQaTasksTable.agentName, agentNames));
  }

  async insertManagerTasks(tasks: QaManagerTaskWrite[]): Promise<Array<{ id: string }>> {
    if (tasks.length === 0) return [];
    return db.insert(managerQaTasksTable)
      .values(tasks)
      .onConflictDoNothing()
      .returning({ id: managerQaTasksTable.id });
  }

  async getLatestBiweeklyRun(): Promise<QaBiweeklyRunRecord | null> {
    const [run] = await db.select().from(qaBiweeklyRunsTable)
      .orderBy(desc(qaBiweeklyRunsTable.startedAt))
      .limit(1);
    return run ?? null;
  }

  async getActiveBiweeklyRun(): Promise<QaBiweeklyRunRecord | null> {
    const [run] = await db.select().from(qaBiweeklyRunsTable)
      .where(eq(qaBiweeklyRunsTable.status, "running"))
      .orderBy(desc(qaBiweeklyRunsTable.startedAt))
      .limit(1);
    return run ?? null;
  }

  async listStatsReviews(input: QaReviewRange) {
    return db.select({
      id: qaReviewsTable.id,
      agentName: qaReviewsTable.agentName,
      score: qaReviewsTable.score,
      softSkillsScore: qaReviewsTable.softSkillsScore,
      protocolScore: qaReviewsTable.protocolScore,
      pass: qaReviewsTable.pass,
      criticalFail: qaReviewsTable.criticalFail,
      managerReviewRequired: qaReviewsTable.managerReviewRequired,
      department: qaReviewsTable.department,
      mentionsTax: sql<boolean>`(${qaReviewsTable.transcript} ~* ${TAX_REGEX})`,
    }).from(qaReviewsTable).where(and(...reviewFilters(input)));
  }

  async listStatsTasks(scope: QaReportingScope) {
    const filters: SQL[] = [];
    if (scope.departments) filters.push(inArray(managerQaTasksTable.department, scope.departments));
    const agentPredicate = identityPredicate(managerQaTasksTable.agentName, scope.authorizedIdentities);
    if (agentPredicate) filters.push(agentPredicate);
    return db.select({
      agentName: managerQaTasksTable.agentName,
      status: managerQaTasksTable.status,
      managerScore: managerQaTasksTable.managerScore,
      variance: managerQaTasksTable.variance,
      createdAt: managerQaTasksTable.createdAt,
    }).from(managerQaTasksTable).where(filters.length ? and(...filters) : undefined);
  }

  async listExportReviews(input: QaReviewRange) {
    const dateColumn = qaReviewDateColumn(input.dateBasis);
    return db.select({
      evaluatedAt: qaReviewsTable.evaluatedAt,
      callDate: qaReviewsTable.callDate,
      agentName: qaReviewsTable.agentName,
      department: qaReviewsTable.department,
      phoneNumber: qaReviewsTable.phoneNumber,
      score: qaReviewsTable.score,
      protocolScore: qaReviewsTable.protocolScore,
      softSkillsScore: qaReviewsTable.softSkillsScore,
      pass: qaReviewsTable.pass,
      criticalFail: qaReviewsTable.criticalFail,
      aiSummary: qaReviewsTable.aiSummary,
      mentionsTax: sql<boolean>`(${qaReviewsTable.transcript} ~* ${TAX_REGEX})`,
    }).from(qaReviewsTable)
      .where(and(...reviewFilters(input)))
      .orderBy(desc(dateColumn));
  }

  async listReviews(input: QaReviewRange & { agent: string; limit: number }): Promise<QaReviewRecord[]> {
    const dateColumn = qaReviewDateColumn(input.dateBasis);
    const filters = reviewFilters(input);
    if (input.agent) filters.push(sql`lower(${qaReviewsTable.agentName}) = ${input.agent.toLowerCase()}`);
    return db.select().from(qaReviewsTable)
      .where(and(...filters))
      .orderBy(desc(dateColumn))
      .limit(input.limit);
  }

  async listManagerTasks(input: QaReportingScope & { statuses: string[]; limit: number }): Promise<QaManagerTaskRecord[]> {
    const filters: SQL[] = [inArray(managerQaTasksTable.status, input.statuses)];
    if (input.departments) filters.push(inArray(managerQaTasksTable.department, input.departments));
    const agentPredicate = identityPredicate(managerQaTasksTable.agentName, input.authorizedIdentities);
    if (agentPredicate) filters.push(agentPredicate);
    return db.select().from(managerQaTasksTable)
      .where(and(...filters))
      .orderBy(desc(managerQaTasksTable.createdAt))
      .limit(input.limit);
  }

  async getManagerTask(id: string): Promise<QaManagerTaskRecord | null> {
    const [task] = await db.select().from(managerQaTasksTable)
      .where(eq(managerQaTasksTable.id, id))
      .limit(1);
    return task ?? null;
  }

  async resolveManagerTask(id: string, update: {
    resolvedBy: string;
    notes: string | null;
    comments: string | null;
    managerScore: number | null;
    variance: number | null;
    finalScore: number;
    coachingComplete: boolean;
  }): Promise<QaManagerTaskRecord | null> {
    const [task] = await db.update(managerQaTasksTable).set({
      status: "resolved",
      resolvedBy: update.resolvedBy,
      resolvedAt: new Date(),
      notes: update.notes,
      comments: update.comments,
      managerScore: update.managerScore,
      variance: update.variance,
      finalScore: update.finalScore,
      coachingComplete: update.coachingComplete,
    }).where(eq(managerQaTasksTable.id, id)).returning();
    return task ?? null;
  }

  async listAgentStats(input: QaReviewRange) {
    return db.select({
      agentName: qaReviewsTable.agentName,
      department: qaReviewsTable.department,
      reviewed: sql<number>`cast(count(*) as int)`,
      avgScore: sql<number>`cast(round(avg(${qaReviewsTable.score})) as int)`,
      avgProtocol: sql<number>`cast(round(avg(${qaReviewsTable.protocolScore})) as int)`,
      avgSoftSkills: sql<number>`cast(round(avg(${qaReviewsTable.softSkillsScore})) as int)`,
      criticalFails: sql<number>`cast(sum(case when ${qaReviewsTable.criticalFail} then 1 else 0 end) as int)`,
      failed: sql<number>`cast(sum(case when ${qaReviewsTable.pass} = false then 1 else 0 end) as int)`,
    }).from(qaReviewsTable)
      .where(and(...reviewFilters(input)))
      .groupBy(qaReviewsTable.agentName, qaReviewsTable.department)
      .orderBy(sql`avg(${qaReviewsTable.score}) asc`);
  }
}

export const qaRepository = new QaRepository();
