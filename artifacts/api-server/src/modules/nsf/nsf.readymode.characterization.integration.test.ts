import assert from "node:assert/strict";
import test from "node:test";
import {
  db,
  nsfReadymodeQueueTable,
  phoneCallsTable,
  pool,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getActiveReadymodeItems } from "../../routes/nsfReadymode.js";
import { nsfReadymodeService } from "./nsf.readymode.service.js";

const databaseUrl = process.env["NSF_READYMODE_TEST_DATABASE_URL"]?.trim();
const activeDatabaseUrl = process.env["DATABASE_URL"]?.trim();
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.toLowerCase() : "";
const enabled = Boolean(
  process.env["NODE_ENV"] === "test"
  && databaseUrl
  && activeDatabaseUrl === databaseUrl
  && databaseName.includes("test"),
);

test("active ReadyMode queue preserves formatting and auto-clears later OpenPhone callbacks", {
  skip: enabled ? false : "DATABASE_URL and NSF_READYMODE_TEST_DATABASE_URL must match an isolated test database",
}, async () => {
  const marker = `${process.pid}-${Date.now()}`;
  const pendingPhone = "2025550101";
  const callbackPhone = "2025550102";
  const completedPhone = "2025550103";
  const addedAt = new Date("2026-08-16T10:00:00.000Z");
  const queueRows = await db.insert(nsfReadymodeQueueTable).values([
    { phoneNumber: pendingPhone, addedBy: marker, addedAt },
    { phoneNumber: callbackPhone, addedBy: marker, addedAt },
    { phoneNumber: completedPhone, addedBy: marker, addedAt, doneAt: addedAt, doneBy: marker },
  ]).returning({ id: nsfReadymodeQueueTable.id });
  const queueIds = queueRows.map((row) => row.id);
  const callbackId = `nsf-readymode-characterization-${marker}`;

  try {
    await db.insert(phoneCallsTable).values({
      id: callbackId,
      lineId: "characterization-line",
      lineName: "Characterization",
      lineTeam: "nsf",
      participant: `+1 (${callbackPhone.slice(0, 3)}) ${callbackPhone.slice(3, 6)}-${callbackPhone.slice(6)}`,
      direction: "outgoing",
      status: "completed",
      createdAt: new Date(addedAt.getTime() + 60_000),
    });

    assert.deepEqual(await getActiveReadymodeItems(), [{
      id: `readymode-${queueIds[0]}`,
      fromNumber: "(202) 555-0101",
      toNumber: "Readymode",
      createdAt: addedAt.toISOString(),
      ringGroupId: -1,
      ringGroupName: "Readymode",
      team: "nsf",
      source: "readymode",
    }]);

    const stored = await db.select({
      id: nsfReadymodeQueueTable.id,
      doneAt: nsfReadymodeQueueTable.doneAt,
      doneBy: nsfReadymodeQueueTable.doneBy,
    }).from(nsfReadymodeQueueTable).where(inArray(nsfReadymodeQueueTable.id, queueIds));
    const autoCleared = stored.find((row) => row.id === queueIds[1]);
    assert.ok(autoCleared?.doneAt instanceof Date);
    assert.equal(autoCleared?.doneBy, "auto:callback");
  } finally {
    await db.delete(phoneCallsTable).where(inArray(phoneCallsTable.id, [callbackId]));
    await db.delete(nsfReadymodeQueueTable).where(inArray(nsfReadymodeQueueTable.id, queueIds));
  }
});

test("ReadyMode queue commands preserve duplicate skipping and manual completion persistence", {
  skip: enabled ? false : "DATABASE_URL and NSF_READYMODE_TEST_DATABASE_URL must match an isolated test database",
}, async () => {
  const marker = `nsf-command-${process.pid}-${Date.now()}`;
  const newPhone = "2025550191";
  const existingPhone = "2025550192";

  await db.insert(nsfReadymodeQueueTable).values({ phoneNumber: existingPhone, addedBy: marker });
  try {
    assert.deepEqual(await nsfReadymodeService.add([newPhone, existingPhone], marker), {
      added: 1,
      skipped: 1,
      addedNumbers: ["(202) 555-0191"],
      skippedNumbers: ["(202) 555-0192"],
    });

    const rows = await db.select({
      id: nsfReadymodeQueueTable.id,
      phoneNumber: nsfReadymodeQueueTable.phoneNumber,
    }).from(nsfReadymodeQueueTable).where(eq(nsfReadymodeQueueTable.addedBy, marker));
    const inserted = rows.find((row) => row.phoneNumber === newPhone);
    assert.ok(inserted);

    await nsfReadymodeService.markDoneById(inserted.id, marker);
    await nsfReadymodeService.markDoneByNumber(existingPhone, marker);

    const completed = await db.select({
      phoneNumber: nsfReadymodeQueueTable.phoneNumber,
      doneAt: nsfReadymodeQueueTable.doneAt,
      doneBy: nsfReadymodeQueueTable.doneBy,
    }).from(nsfReadymodeQueueTable).where(eq(nsfReadymodeQueueTable.addedBy, marker));
    assert.equal(completed.length, 2);
    assert.ok(completed.every((row) => row.doneAt instanceof Date && row.doneBy === marker));
  } finally {
    await db.delete(nsfReadymodeQueueTable).where(eq(nsfReadymodeQueueTable.addedBy, marker));
  }
});

test.after(async () => {
  if (enabled) await pool.end();
});
