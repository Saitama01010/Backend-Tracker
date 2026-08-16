import { db, nsfReadymodeQueueTable, phoneCallsTable } from "@workspace/db";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";

export type ActiveReadymodeQueueRow = {
  id: number;
  phoneNumber: string;
  addedAt: Date;
};

export type ReadymodeOutboundRow = {
  participant: string;
  createdAt: Date;
};

export interface NsfReadymodeRepository {
  listActive(): Promise<ActiveReadymodeQueueRow[]>;
  listOutboundSince(earliest: Date): Promise<ReadymodeOutboundRow[]>;
  markDoneByIds(ids: number[], doneAt: Date, doneBy: string): Promise<void>;
}

export class PostgresNsfReadymodeRepository implements NsfReadymodeRepository {
  async listActive(): Promise<ActiveReadymodeQueueRow[]> {
    return db
      .select({
        id: nsfReadymodeQueueTable.id,
        phoneNumber: nsfReadymodeQueueTable.phoneNumber,
        addedAt: nsfReadymodeQueueTable.addedAt,
      })
      .from(nsfReadymodeQueueTable)
      .where(isNull(nsfReadymodeQueueTable.doneAt));
  }

  async listOutboundSince(earliest: Date): Promise<ReadymodeOutboundRow[]> {
    return db
      .select({
        participant: phoneCallsTable.participant,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(
        and(
          eq(phoneCallsTable.direction, "outgoing"),
          gte(phoneCallsTable.createdAt, earliest),
        ),
      );
  }

  async markDoneByIds(ids: number[], doneAt: Date, doneBy: string): Promise<void> {
    if (ids.length === 0) return;
    await db
      .update(nsfReadymodeQueueTable)
      .set({ doneAt, doneBy })
      .where(inArray(nsfReadymodeQueueTable.id, ids));
  }
}

export const nsfReadymodeRepository = new PostgresNsfReadymodeRepository();
