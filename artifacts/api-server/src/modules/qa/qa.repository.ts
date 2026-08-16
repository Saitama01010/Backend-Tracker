import {
  db,
  managerQaTasksTable,
  phoneCallsTable,
  qaBiweeklyRunsTable,
  qaReviewsTable,
  teamAgentsTable,
} from "@workspace/db";
import { and, desc, eq, gt, gte, inArray } from "drizzle-orm";

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
}

export const qaRepository = new QaRepository();
