import { Router } from "express";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, nsfReadymodeQueueTable, phoneCallsTable } from "@workspace/db";

const router = Router();

export interface ReadymodeItem {
  id: string;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "nsf";
  source: "readymode";
}

function normalizePhone(num: string): string {
  const digits = (num ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function formatPhone(num: string): string {
  const d = normalizePhone(num);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return num;
}

/**
 * Returns active NSF Readymode queue items, after auto-clearing any whose
 * phone number has received an outbound call in OpenPhone since they were added.
 * Items are returned in the MissedNoCallbackItem shape so they can be merged
 * straight into the existing missed-no-callback list.
 */
export async function getActiveReadymodeItems(): Promise<ReadymodeItem[]> {
  const active = await db
    .select()
    .from(nsfReadymodeQueueTable)
    .where(isNull(nsfReadymodeQueueTable.doneAt));

  if (active.length === 0) return [];

  // Build a set of normalized numbers we have outbound calls for, since the
  // earliest addedAt in the queue (cheap, single scan).
  const earliest = active.reduce(
    (min, r) => (r.addedAt < min ? r.addedAt : min),
    active[0]!.addedAt,
  );
  const outbound = await db
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

  const callbackTimes = new Map<string, Date[]>();
  for (const o of outbound) {
    const n = normalizePhone(o.participant);
    if (!n) continue;
    if (!callbackTimes.has(n)) callbackTimes.set(n, []);
    callbackTimes.get(n)!.push(new Date(o.createdAt));
  }

  const autoDone: number[] = [];
  const items: ReadymodeItem[] = [];
  for (const row of active) {
    const norm = normalizePhone(row.phoneNumber);
    const times = callbackTimes.get(norm);
    const hasCallback = times?.some((t) => t >= row.addedAt) ?? false;
    if (hasCallback) {
      autoDone.push(row.id);
      continue;
    }
    items.push({
      id: `readymode-${row.id}`,
      fromNumber: formatPhone(row.phoneNumber),
      toNumber: "Readymode",
      createdAt: row.addedAt.toISOString(),
      ringGroupId: -1,
      ringGroupName: "Readymode",
      team: "nsf",
      source: "readymode",
    });
  }

  if (autoDone.length > 0) {
    await db
      .update(nsfReadymodeQueueTable)
      .set({ doneAt: new Date(), doneBy: "auto:callback" })
      .where(inArray(nsfReadymodeQueueTable.id, autoDone));
  }

  return items;
}

/**
 * POST /api/nsf/readymode-queue
 * Body: { numbers: string[], addedBy?: string }
 * Adds NSF Readymode missed-call numbers to the queue.
 * Duplicate active entries for the same normalized number are skipped.
 */
router.post("/nsf/readymode-queue", async (req, res) => {
  try {
    const body = req.body as { numbers?: unknown; addedBy?: unknown };
    const raw = Array.isArray(body.numbers) ? body.numbers : [];
    const addedBy =
      typeof body.addedBy === "string" && body.addedBy.trim()
        ? body.addedBy.trim()
        : ((req as { user?: { username?: string } }).user?.username ?? "samia");

    const norms = Array.from(
      new Set(
        raw
          .map((n) => (typeof n === "string" ? normalizePhone(n) : ""))
          .filter((n) => n.length === 10),
      ),
    );
    if (norms.length === 0) {
      return res.status(400).json({ error: "No valid 10-digit numbers provided." });
    }

    // Skip numbers that already have an active entry.
    const existing = await db
      .select({ phoneNumber: nsfReadymodeQueueTable.phoneNumber })
      .from(nsfReadymodeQueueTable)
      .where(
        and(
          isNull(nsfReadymodeQueueTable.doneAt),
          inArray(nsfReadymodeQueueTable.phoneNumber, norms),
        ),
      );
    const skip = new Set(existing.map((e) => e.phoneNumber));
    const toInsert = norms
      .filter((n) => !skip.has(n))
      .map((n) => ({ phoneNumber: n, addedBy }));

    let inserted: { id: number; phoneNumber: string }[] = [];
    if (toInsert.length > 0) {
      inserted = await db
        .insert(nsfReadymodeQueueTable)
        .values(toInsert)
        .returning({
          id: nsfReadymodeQueueTable.id,
          phoneNumber: nsfReadymodeQueueTable.phoneNumber,
        });
    }

    return res.json({
      added: inserted.length,
      skipped: skip.size,
      addedNumbers: inserted.map((i) => formatPhone(i.phoneNumber)),
      skippedNumbers: Array.from(skip).map(formatPhone),
    });
  } catch (err) {
    req.log.error(err, "nsf readymode add error");
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/nsf/readymode-queue
 * Returns the current active queue (already auto-cleared for callbacks).
 */
router.get("/nsf/readymode-queue", async (_req, res) => {
  const items = await getActiveReadymodeItems();
  return res.json({ items });
});

/**
 * POST /api/nsf/readymode-queue/:id/done
 * Manually mark a queue entry as done.
 */
router.post("/nsf/readymode-queue/:id/done", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  const doneBy =
    (req as { user?: { username?: string } }).user?.username ?? "manual";
  await db
    .update(nsfReadymodeQueueTable)
    .set({ doneAt: new Date(), doneBy })
    .where(
      and(eq(nsfReadymodeQueueTable.id, id), isNull(nsfReadymodeQueueTable.doneAt)),
    );
  return res.json({ ok: true });
});

/**
 * POST /api/nsf/readymode-queue/done-by-number
 * Body: { number: string }
 * Marks the active queue entry for the given number as done (used by the UI's
 * Done button on rows whose row id is `readymode-<id>`).
 */
router.post("/nsf/readymode-queue/done-by-number", async (req, res) => {
  const body = req.body as { number?: unknown };
  const norm = typeof body.number === "string" ? normalizePhone(body.number) : "";
  if (norm.length !== 10) return res.status(400).json({ error: "Invalid number" });
  const doneBy =
    (req as { user?: { username?: string } }).user?.username ?? "manual";
  await db
    .update(nsfReadymodeQueueTable)
    .set({ doneAt: new Date(), doneBy })
    .where(
      and(
        eq(nsfReadymodeQueueTable.phoneNumber, norm),
        isNull(nsfReadymodeQueueTable.doneAt),
      ),
    );
  return res.json({ ok: true });
});

// Avoid "unused import" warnings when not all helpers are referenced.
void sql;

export default router;
