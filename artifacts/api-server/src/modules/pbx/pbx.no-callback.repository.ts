import { db, phoneCallsTable, pbxMissedCallsTable } from "@workspace/db";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { postgresBackgroundJobStore } from "../../lib/backgroundJobStore.js";
import { getBlockedNumbers } from "../../lib/blockedNumbers.js";
import { scheduledJobKey } from "../../lib/durableBackgroundJobs.js";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";

export type PbxNoCallbackQuoMissedRow = {
  id: string;
  participant: string;
  lineId: string;
  lineTeam: string;
  lineName: string;
  status: string;
  durationSeconds: number;
  ringDurationSeconds: number | null;
  createdAt: Date;
};

export type PbxNoCallbackCallbackRow = {
  id: string;
  participant: string;
  createdAt: Date;
};

export type PbxNoCallbackMissedRow = {
  id: number;
  fromNumber: string;
  toNumber: string;
  createdAt: Date | string;
  ringGroupId: number;
  ringGroupName: string;
  team?: string | null;
};

export type PbxNoCallbackFallbackRows = {
  quoMissed: PbxNoCallbackQuoMissedRow[];
  quoOutbound: PbxNoCallbackCallbackRow[];
  quoInboundAnswered: PbxNoCallbackCallbackRow[];
  persistedPbxMissed: PbxNoCallbackMissedRow[];
};

export interface PbxNoCallbackRepository {
  enqueueRefresh(minuteBucket: string): Promise<void>;
  loadFallback(input: { from: Date; to?: Date }): Promise<PbxNoCallbackFallbackRows>;
  loadBlockedNumbers(): Promise<Set<string>>;
}

const trackedTeamLines = [...OPERATIONAL_CONFIG.trackedTeamLines];

export class PostgresPbxNoCallbackRepository implements PbxNoCallbackRepository {
  async enqueueRefresh(minuteBucket: string): Promise<void> {
    await postgresBackgroundJobStore.enqueue({
      jobType: "integration_live_refresh",
      idempotencyKey: scheduledJobKey("integration_live_refresh", minuteBucket),
      priority: 100,
      maxAttempts: 4,
    });
  }

  async loadFallback(input: { from: Date; to?: Date }): Promise<PbxNoCallbackFallbackRows> {
    const phoneDateConditions = input.to
      ? [gte(phoneCallsTable.createdAt, input.from), lt(phoneCallsTable.createdAt, input.to)]
      : [gte(phoneCallsTable.createdAt, input.from)];
    const pbxDateConditions = input.to
      ? [gte(pbxMissedCallsTable.createdAt, input.from), lt(pbxMissedCallsTable.createdAt, input.to)]
      : [gte(pbxMissedCallsTable.createdAt, input.from)];
    const [quoMissed, quoOutbound, quoInboundAnswered, persistedPbxMissed] = await Promise.all([
      db
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
          ...phoneDateConditions,
          inArray(phoneCallsTable.lineName, trackedTeamLines),
        )),
      db
        .select({
          id: phoneCallsTable.id,
          participant: phoneCallsTable.participant,
          createdAt: phoneCallsTable.createdAt,
        })
        .from(phoneCallsTable)
        .where(and(eq(phoneCallsTable.direction, "outgoing"), ...phoneDateConditions)),
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
          ...phoneDateConditions,
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
        .where(and(...pbxDateConditions)),
    ]);
    return { quoMissed, quoOutbound, quoInboundAnswered, persistedPbxMissed };
  }

  async loadBlockedNumbers(): Promise<Set<string>> {
    return getBlockedNumbers();
  }
}

export const pbxNoCallbackRepository = new PostgresPbxNoCallbackRepository();
