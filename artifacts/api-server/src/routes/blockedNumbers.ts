import { Router } from "express";
import { db, blockedNumbersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { invalidateBlockedNumbersCache } from "../lib/blockedNumbers.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/blocked-numbers", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(blockedNumbersTable).orderBy(blockedNumbersTable.createdAt);
    return res.json({ data: rows });
  } catch (err) {
    req.log.error(err, "blocked-numbers list error");
    return res.status(500).json({ error: String(err) });
  }
});

router.post("/blocked-numbers", requireAuth, requireRole("admin", "edit"), async (req, res) => {
  try {
    const { number, note } = req.body as { number?: string; note?: string };
    if (!number || typeof number !== "string") {
      return res.status(400).json({ error: "number is required" });
    }
    const normalized = number.trim();
    await db.insert(blockedNumbersTable).values({ number: normalized, note: note?.trim() ?? null }).onConflictDoNothing();
    invalidateBlockedNumbersCache();
    return res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "blocked-numbers insert error");
    return res.status(500).json({ error: String(err) });
  }
});

router.delete("/blocked-numbers/:number", requireAuth, requireRole("admin", "edit"), async (req, res) => {
  try {
    const rawNumber = req.params["number"];
    const number = decodeURIComponent(Array.isArray(rawNumber) ? rawNumber[0] ?? "" : rawNumber ?? "");
    await db.delete(blockedNumbersTable).where(eq(blockedNumbersTable.number, number));
    invalidateBlockedNumbersCache();
    return res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "blocked-numbers delete error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
