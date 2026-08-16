import { db, readymodeUploadsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { ReadyModeDayRow } from "./csvParser.js";

export type ReadyModeUploadValue = {
  agentName: string;
  statDate: string;
  dialed: number;
  talkSecs: number;
  uploadedBy: string;
};

export function prepareReadyModeUpload(
  rows: ReadyModeDayRow[],
  uploadedBy: string,
): ReadyModeUploadValue[] {
  const canonName = (value: string) => value.trim().replace(/\s+/g, " ");
  const byKey = new Map<string, ReadyModeDayRow>();
  for (const row of rows) {
    const name = canonName(row.name);
    byKey.set(`${name.toLowerCase()}|${row.iso}`, { ...row, name });
  }
  return [...byKey.values()].map((row) => ({
    agentName: row.name,
    statDate: row.iso,
    dialed: row.dialed,
    talkSecs: row.talkSecs,
    uploadedBy,
  }));
}

export async function persistReadyModeUpload(values: ReadyModeUploadValue[]): Promise<void> {
  await db
    .insert(readymodeUploadsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [readymodeUploadsTable.agentName, readymodeUploadsTable.statDate],
      set: {
        dialed: sql`excluded.dialed`,
        talkSecs: sql`excluded.talk_secs`,
        uploadedBy: sql`excluded.uploaded_by`,
        uploadedAt: sql`now()`,
      },
    });
}
