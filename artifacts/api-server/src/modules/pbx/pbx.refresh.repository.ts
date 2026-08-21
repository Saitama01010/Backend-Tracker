import { db, phoneCallsTable, pbxMissedCallsTable } from "@workspace/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import { postgresBackgroundJobStore } from "../../lib/backgroundJobStore.js";
import { getBlockedNumbers } from "../../lib/blockedNumbers.js";
import { manualJobKey } from "../../lib/durableBackgroundJobs.js";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";
import type {
  PbxNoCallbackCallbackRow,
  PbxNoCallbackMissedRow,
  PbxNoCallbackQuoMissedRow,
} from "./pbx.no-callback.repository.js";

export type PbxRefreshCallbackRows = {
  quoOutbound: PbxNoCallbackCallbackRow[];
  quoInboundAnswered: PbxNoCallbackCallbackRow[];
  persistedPbxMissed: PbxNoCallbackMissedRow[];
};

export type PbxRefreshMissedInsert = {
  id: number;
  fromNumber: string;
  toNumber: string;
  ringGroupId: number;
  ringGroupName: string;
  team: string;
  createdAt: Date;
};

export interface PbxRefreshRepository {
  loadBlockedNumbers(): Promise<Set<string>>;
  loadCallbackRows(since: Date): Promise<PbxRefreshCallbackRows>;
  loadQuoMissed(since: Date): Promise<PbxNoCallbackQuoMissedRow[]>;
  upsertMissed(rows: PbxRefreshMissedInsert[]): Promise<void>;
  enqueueManualRefresh(userId: number, requestedAt: Date): Promise<void>;
}

const trackedTeamLines = [...OPERATIONAL_CONFIG.trackedTeamLines];

export class PostgresPbxRefreshRepository implements PbxRefreshRepository {
  async loadBlockedNumbers(): Promise<Set<string>> {
    return getBlockedNumbers();
  }

  async loadCallbackRows(since: Date): Promise<PbxRefreshCallbackRows> {
    const [quoOutbound, quoInboundAnswered, persistedPbxMissed] = await Promise.all([
      db
        .select({
          id: phoneCallsTable.id,
          participant: phoneCallsTable.participant,
          createdAt: phoneCallsTable.createdAt,
        })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "outgoing"), gte(phoneCallsTable.createdAt, since))),
      db
        .select({
          id: phoneCallsTable.id,
          participant: phoneCallsTable.participant,
          createdAt: phoneCallsTable.createdAt,
        })
        .from(phoneCallsTable)
        .where(and(
          eq(phoneCallsTable.direction, "incoming"),
          eq(phoneCallsTable.status, "completed"),
          gte(phoneCallsTable.createdAt, since),
        )),
      db
        .select({
          id: pbxMissedCallsTable.id,
          fromNumber: pbxMissedCallsTable.fromNumber,
          toNumber: pbxMissedCallsTable.toNumber,
          createdAt: pbxMissedCallsTable.createdAt,
          ringGroupId: pbxMissedCallsTable.ringGroupId,
          ringGroupName: pbxMissedCallsTable.ringGroupName,
          team: pbxMissedCallsTable.team,
        })
        .from(pbxMissedCallsTable)
        .where(gte(pbxMissedCallsTable.createdAt, since)),
    ]);
    return { quoOutbound, quoInboundAnswered, persistedPbxMissed };
  }

  async loadQuoMissed(since: Date): Promise<PbxNoCallbackQuoMissedRow[]> {
    return db
      .select({
        id: phoneCallsTable.id,
        participant: phoneCallsTable.participant,
        lineId: phoneCallsTable.lineId,
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        ringDurationSeconds: phoneCallsTable.ringDurationSeconds,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(and(
        eq(phoneCallsTable.direction, "incoming"),
        inArray(phoneCallsTable.status, ["no-answer", "voicemail", "missed", "voicemail-brief"]),
        gte(phoneCallsTable.createdAt, since),
        inArray(phoneCallsTable.lineName, trackedTeamLines),
      ));
  }

  async upsertMissed(rows: PbxRefreshMissedInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await db.insert(pbxMissedCallsTable).values(rows).onConflictDoNothing();
  }

  async enqueueManualRefresh(userId: number, requestedAt: Date): Promise<void> {
    await postgresBackgroundJobStore.enqueue({
      jobType: "integration_live_refresh",
      idempotencyKey: manualJobKey("integration_live_refresh", userId, requestedAt, 5_000),
      requestedByUserId: userId,
      priority: 100,
      maxAttempts: 4,
    });
  }
}

export const pbxRefreshRepository = new PostgresPbxRefreshRepository();
