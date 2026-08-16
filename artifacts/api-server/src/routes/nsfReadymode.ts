import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, nsfReadymodeQueueTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  nsfReadymodeService,
  type ReadymodeItem,
} from "../modules/nsf/nsf.readymode.service.js";
import {
  formatNsfReadymodePhone,
  parseNsfReadymodeDoneNumber,
  parseNsfReadymodeId,
  parseNsfReadymodeNumbers,
  resolveNsfReadymodeActor,
} from "../modules/nsf/nsf.readymode.schemas.js";

const router = Router();
router.use("/nsf", requireAuth);

export type { ReadymodeItem } from "../modules/nsf/nsf.readymode.service.js";

/**
 * Returns active NSF Readymode queue items, after auto-clearing any whose
 * phone number has received an outbound call in OpenPhone since they were added.
 * Items are returned in the MissedNoCallbackItem shape so they can be merged
 * straight into the existing missed-no-callback list.
 */
export async function getActiveReadymodeItems(): Promise<ReadymodeItem[]> {
  return nsfReadymodeService.listActive();
}

/**
 * POST /api/nsf/readymode-queue
 * Body: { numbers: string[], addedBy?: string }
 * Adds NSF Readymode missed-call numbers to the queue.
 * Duplicate active entries for the same normalized number are skipped.
 */
router.post("/nsf/readymode-queue", requireRole("admin"), async (req, res) => {
  try {
    const body = req.body as { numbers?: unknown; addedBy?: unknown };
    const parsed = parseNsfReadymodeNumbers(body.numbers);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const norms = parsed.value;
    const addedBy = resolveNsfReadymodeActor(body.addedBy, req.user?.username, "samia");

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
      addedNumbers: inserted.map((i) => formatNsfReadymodePhone(i.phoneNumber)),
      skippedNumbers: Array.from(skip).map(formatNsfReadymodePhone),
    });
  } catch (err) {
    req.log.error(err, "nsf readymode add error");
    return res.status(500).json({ error: "ReadyMode queue update failed." });
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
  const id = parseNsfReadymodeId(req.params["id"]);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const doneBy = resolveNsfReadymodeActor(undefined, req.user?.username, "manual");
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
  const norm = parseNsfReadymodeDoneNumber(body.number);
  if (norm === null) return res.status(400).json({ error: "Invalid number" });
  const doneBy = resolveNsfReadymodeActor(undefined, req.user?.username, "manual");
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
