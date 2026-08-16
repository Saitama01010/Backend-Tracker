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

export type NewReadymodeQueueRow = {
  phoneNumber: string;
  addedBy: string;
};

export type InsertedReadymodeQueueRow = {
  id: number;
  phoneNumber: string;
};

export interface NsfReadymodeRepository {
  listActive(): Promise<ActiveReadymodeQueueRow[]>;
  listOutboundSince(earliest: Date): Promise<ReadymodeOutboundRow[]>;
  listExistingActiveNumbers(phoneNumbers: string[]): Promise<string[]>;
  insertQueueRows(rows: NewReadymodeQueueRow[]): Promise<InsertedReadymodeQueueRow[]>;
  markDoneByIds(ids: number[], doneAt: Date, doneBy: string): Promise<void>;
  markDoneById(id: number, doneAt: Date, doneBy: string): Promise<void>;
  markDoneByNumber(phoneNumber: string, doneAt: Date, doneBy: string): Promise<void>;
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

  async listExistingActiveNumbers(phoneNumbers: string[]): Promise<string[]> {
    if (phoneNumbers.length === 0) return [];
    const rows = await db
      .select({ phoneNumber: nsfReadymodeQueueTable.phoneNumber })
      .from(nsfReadymodeQueueTable)
      .where(
        and(
          isNull(nsfReadymodeQueueTable.doneAt),
          inArray(nsfReadymodeQueueTable.phoneNumber, phoneNumbers),
        ),
      );
    return rows.map((row) => row.phoneNumber);
  }

  async insertQueueRows(rows: NewReadymodeQueueRow[]): Promise<InsertedReadymodeQueueRow[]> {
    if (rows.length === 0) return [];
    return db
      .insert(nsfReadymodeQueueTable)
      .values(rows)
      .returning({
        id: nsfReadymodeQueueTable.id,
        phoneNumber: nsfReadymodeQueueTable.phoneNumber,
      });
  }

  async markDoneByIds(ids: number[], doneAt: Date, doneBy: string): Promise<void> {
    if (ids.length === 0) return;
    await db
      .update(nsfReadymodeQueueTable)
      .set({ doneAt, doneBy })
      .where(inArray(nsfReadymodeQueueTable.id, ids));
  }

  async markDoneById(id: number, doneAt: Date, doneBy: string): Promise<void> {
    await db
      .update(nsfReadymodeQueueTable)
      .set({ doneAt, doneBy })
      .where(and(eq(nsfReadymodeQueueTable.id, id), isNull(nsfReadymodeQueueTable.doneAt)));
  }

  async markDoneByNumber(phoneNumber: string, doneAt: Date, doneBy: string): Promise<void> {
    await db
      .update(nsfReadymodeQueueTable)
      .set({ doneAt, doneBy })
      .where(
        and(
          eq(nsfReadymodeQueueTable.phoneNumber, phoneNumber),
          isNull(nsfReadymodeQueueTable.doneAt),
        ),
      );
  }
}

export const nsfReadymodeRepository = new PostgresNsfReadymodeRepository();
