import {
  db,
  onboardingClassificationsTable,
  onboardingReportStateTable,
  phoneCallsTable,
} from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";

export interface OnboardingReportStatePatch {
  isRunning?: boolean;
  progressDone?: number;
  progressTotal?: number;
  lastRunAt?: Date | null;
  lastError?: string | null;
}

export interface OnboardingReportState {
  progressDone: number;
  progressTotal: number;
  lastRunAt: Date | null;
  lastError: string | null;
}

export interface PendingOnboardingCall {
  id: string;
  agentName: string | null;
  direction: string;
}

export interface OnboardingClassificationWrite {
  callId: string;
  callType: string;
  customerName: string | null;
  closerAgent: string | null;
  mentionsTax: boolean | null;
  txStatus: string | null;
  notes: string;
}

export interface OnboardingClassificationImportRow {
  callId: string;
  callType: string;
  customerName?: string | null;
  closerAgent?: string | null;
  mentionsTax?: boolean | null;
  txStatus?: string | null;
  notes?: string | null;
}

export interface OnboardingReportRangeQuery {
  lineId: string;
  fromDate: Date;
  toDate: Date;
}

export interface RawOnboardingReportRow {
  id: string;
  participant: string;
  agentName: string | null;
  direction: string;
  status: string;
  durationSeconds: number;
  createdAt: Date;
  callType: string | null;
  customerName: string | null;
  closerAgent: string | null;
  mentionsTax: boolean | null;
}

export interface OnboardingReportCounts {
  typeCounts: Array<{ callType: string; n: number }>;
  taxCounts: Array<{ mentionsTax: boolean | null; n: number }>;
  totalCalls: number;
}

export interface OnboardingReportRepository {
  readState(): Promise<OnboardingReportState | null>;
  writeState(patch: OnboardingReportStatePatch): Promise<void>;
  listPending(lineId: string): Promise<PendingOnboardingCall[]>;
  insertClassification(value: OnboardingClassificationWrite): Promise<void>;
  loadReportRows(query: OnboardingReportRangeQuery): Promise<RawOnboardingReportRow[]>;
  loadCounts(query: OnboardingReportRangeQuery): Promise<OnboardingReportCounts>;
  importClassifications(values: readonly OnboardingClassificationImportRow[]): Promise<number>;
}

function rangeWhere(query: OnboardingReportRangeQuery) {
  return and(
    eq(phoneCallsTable.lineId, query.lineId),
    gte(phoneCallsTable.createdAt, query.fromDate),
    lte(phoneCallsTable.createdAt, query.toDate),
  );
}

export class PostgresOnboardingReportRepository implements OnboardingReportRepository {
  async readState(): Promise<OnboardingReportState | null> {
    const rows = await db
      .select({
        progressDone: onboardingReportStateTable.progressDone,
        progressTotal: onboardingReportStateTable.progressTotal,
        lastRunAt: onboardingReportStateTable.lastRunAt,
        lastError: onboardingReportStateTable.lastError,
      })
      .from(onboardingReportStateTable)
      .where(eq(onboardingReportStateTable.id, "singleton"));
    return rows[0] ?? null;
  }

  async writeState(patch: OnboardingReportStatePatch): Promise<void> {
    await db
      .insert(onboardingReportStateTable)
      .values({ id: "singleton", ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: onboardingReportStateTable.id,
        set: { ...patch, updatedAt: new Date() },
      });
  }

  async listPending(lineId: string): Promise<PendingOnboardingCall[]> {
    return db
      .select({
        id: phoneCallsTable.id,
        agentName: phoneCallsTable.agentName,
        direction: phoneCallsTable.direction,
      })
      .from(phoneCallsTable)
      .leftJoin(
        onboardingClassificationsTable,
        eq(onboardingClassificationsTable.callId, phoneCallsTable.id),
      )
      .where(
        and(
          eq(phoneCallsTable.lineId, lineId),
          eq(phoneCallsTable.status, "completed"),
          sql`${onboardingClassificationsTable.callId} IS NULL`,
        ),
      );
  }

  async insertClassification(value: OnboardingClassificationWrite): Promise<void> {
    await db
      .insert(onboardingClassificationsTable)
      .values(value)
      .onConflictDoNothing();
  }

  async loadReportRows(query: OnboardingReportRangeQuery): Promise<RawOnboardingReportRow[]> {
    return db
      .select({
        id: phoneCallsTable.id,
        participant: phoneCallsTable.participant,
        agentName: phoneCallsTable.agentName,
        direction: phoneCallsTable.direction,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        createdAt: phoneCallsTable.createdAt,
        callType: onboardingClassificationsTable.callType,
        customerName: onboardingClassificationsTable.customerName,
        closerAgent: onboardingClassificationsTable.closerAgent,
        mentionsTax: onboardingClassificationsTable.mentionsTax,
      })
      .from(phoneCallsTable)
      .leftJoin(
        onboardingClassificationsTable,
        eq(onboardingClassificationsTable.callId, phoneCallsTable.id),
      )
      .where(rangeWhere(query))
      .orderBy(phoneCallsTable.createdAt);
  }

  async loadCounts(query: OnboardingReportRangeQuery): Promise<OnboardingReportCounts> {
    const where = rangeWhere(query);
    const typeCounts = await db
      .select({ callType: onboardingClassificationsTable.callType, n: sql<number>`count(*)::int` })
      .from(onboardingClassificationsTable)
      .innerJoin(phoneCallsTable, eq(phoneCallsTable.id, onboardingClassificationsTable.callId))
      .where(where)
      .groupBy(onboardingClassificationsTable.callType);
    const taxCounts = await db
      .select({ mentionsTax: onboardingClassificationsTable.mentionsTax, n: sql<number>`count(*)::int` })
      .from(onboardingClassificationsTable)
      .innerJoin(phoneCallsTable, eq(phoneCallsTable.id, onboardingClassificationsTable.callId))
      .where(where)
      .groupBy(onboardingClassificationsTable.mentionsTax);
    const totalCalls = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(phoneCallsTable)
      .where(where);
    return { typeCounts, taxCounts, totalCalls: totalCalls[0]?.n ?? 0 };
  }

  async importClassifications(values: readonly OnboardingClassificationImportRow[]): Promise<number> {
    const chunkSize = 500;
    for (let index = 0; index < values.length; index += chunkSize) {
      await db
        .insert(onboardingClassificationsTable)
        .values(values.slice(index, index + chunkSize))
        .onConflictDoNothing();
    }
    const total = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(onboardingClassificationsTable);
    return total[0]?.n ?? 0;
  }
}

export const onboardingReportRepository = new PostgresOnboardingReportRepository();
