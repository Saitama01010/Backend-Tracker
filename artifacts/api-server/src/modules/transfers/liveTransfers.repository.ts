import {
  db,
  liveTransferClassificationsTable,
  liveTransferStateTable,
  phoneCallsTable,
} from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";

export interface LiveTransferStatePatch {
  isRunning?: boolean;
  progressDone?: number;
  progressTotal?: number;
  lastRunAt?: Date | null;
  lastError?: string | null;
}

export interface LiveTransferState {
  progressDone: number;
  progressTotal: number;
  lastRunAt: Date | null;
}

export interface LiveTransferClassificationWrite {
  callId: string;
  isLive: boolean;
  kind?: string | null;
  company: string | null;
  agent: string | null;
  evidence: string | null;
  txStatus: string | null;
}

export interface LiveTransferRangeQuery {
  lineId: string;
  fromDate: Date;
  toDate: Date;
}

export interface LiveTransferStatusQuery extends LiveTransferRangeQuery {
  minimumSeconds: number;
}

export interface RawLiveTransferRow {
  id: string;
  participant: string;
  lineName: string;
  agentName: string | null;
  durationSeconds: number;
  createdAt: Date;
  kind: string | null;
  company: string | null;
  agent: string | null;
  evidence: string | null;
}

export interface LiveTransferStatusData {
  totalIncoming: number;
  byKindCompany: Array<{ kind: string | null; company: string | null; cnt: number }>;
}

export interface LiveTransferRepository {
  readState(): Promise<LiveTransferState | null>;
  writeState(patch: LiveTransferStatePatch): Promise<void>;
  listPending(lineId: string, minimumSeconds: number): Promise<Array<{ id: string }>>;
  insertClassification(value: LiveTransferClassificationWrite): Promise<void>;
  loadRows(query: LiveTransferRangeQuery): Promise<RawLiveTransferRow[]>;
  loadStatus(query: LiveTransferStatusQuery): Promise<LiveTransferStatusData>;
}

function scope(lineId: string) {
  return eq(phoneCallsTable.lineId, lineId);
}

function inRange(query: LiveTransferRangeQuery) {
  return and(
    gte(phoneCallsTable.createdAt, query.fromDate),
    lte(phoneCallsTable.createdAt, query.toDate),
  );
}

export class PostgresLiveTransferRepository implements LiveTransferRepository {
  async readState(): Promise<LiveTransferState | null> {
    const rows = await db
      .select({
        progressDone: liveTransferStateTable.progressDone,
        progressTotal: liveTransferStateTable.progressTotal,
        lastRunAt: liveTransferStateTable.lastRunAt,
      })
      .from(liveTransferStateTable)
      .where(eq(liveTransferStateTable.id, "singleton"));
    return rows[0] ?? null;
  }

  async writeState(patch: LiveTransferStatePatch): Promise<void> {
    await db
      .insert(liveTransferStateTable)
      .values({ id: "singleton", ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: liveTransferStateTable.id,
        set: { ...patch, updatedAt: new Date() },
      });
  }

  async listPending(lineId: string, minimumSeconds: number): Promise<Array<{ id: string }>> {
    return db
      .select({ id: phoneCallsTable.id })
      .from(phoneCallsTable)
      .leftJoin(
        liveTransferClassificationsTable,
        eq(liveTransferClassificationsTable.callId, phoneCallsTable.id),
      )
      .where(
        and(
          eq(phoneCallsTable.direction, "incoming"),
          eq(phoneCallsTable.status, "completed"),
          gte(phoneCallsTable.durationSeconds, minimumSeconds),
          scope(lineId),
          sql`${liveTransferClassificationsTable.callId} IS NULL`,
        ),
      );
  }

  async insertClassification(value: LiveTransferClassificationWrite): Promise<void> {
    await db
      .insert(liveTransferClassificationsTable)
      .values(value)
      .onConflictDoNothing();
  }

  async loadRows(query: LiveTransferRangeQuery): Promise<RawLiveTransferRow[]> {
    return db
      .select({
        id: phoneCallsTable.id,
        participant: phoneCallsTable.participant,
        lineName: phoneCallsTable.lineName,
        agentName: phoneCallsTable.agentName,
        durationSeconds: phoneCallsTable.durationSeconds,
        createdAt: phoneCallsTable.createdAt,
        kind: liveTransferClassificationsTable.kind,
        company: liveTransferClassificationsTable.company,
        agent: liveTransferClassificationsTable.agent,
        evidence: liveTransferClassificationsTable.evidence,
      })
      .from(phoneCallsTable)
      .innerJoin(
        liveTransferClassificationsTable,
        eq(liveTransferClassificationsTable.callId, phoneCallsTable.id),
      )
      .where(
        and(
          eq(liveTransferClassificationsTable.isLive, true),
          scope(query.lineId),
          inRange(query),
        ),
      )
      .orderBy(phoneCallsTable.createdAt);
  }

  async loadStatus(query: LiveTransferStatusQuery): Promise<LiveTransferStatusData> {
    const [{ totalIncoming }] = await db
      .select({ totalIncoming: sql<number>`cast(count(*) as int)` })
      .from(phoneCallsTable)
      .where(
        and(
          eq(phoneCallsTable.direction, "incoming"),
          eq(phoneCallsTable.status, "completed"),
          gte(phoneCallsTable.durationSeconds, query.minimumSeconds),
          scope(query.lineId),
          inRange(query),
        ),
      );
    const byKindCompany = await db
      .select({
        kind: liveTransferClassificationsTable.kind,
        company: liveTransferClassificationsTable.company,
        cnt: sql<number>`cast(count(*) as int)`,
      })
      .from(liveTransferClassificationsTable)
      .innerJoin(phoneCallsTable, eq(phoneCallsTable.id, liveTransferClassificationsTable.callId))
      .where(
        and(
          eq(liveTransferClassificationsTable.isLive, true),
          scope(query.lineId),
          inRange(query),
        ),
      )
      .groupBy(liveTransferClassificationsTable.kind, liveTransferClassificationsTable.company);
    return { totalIncoming: Number(totalIncoming) || 0, byKindCompany };
  }
}

export const liveTransferRepository = new PostgresLiveTransferRepository();
