import { Router } from "express";
import { db, agentBreaksTable } from "@workspace/db";
import { and, eq, gte, lte, isNull, or, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/breaks/start
 * Body: { agentName, department, breakStart?, note?, loggedBy? }
 * Opens a break session (breakEnd = null = still on break).
 */
router.post("/breaks/start", requireAuth, requireRole("admin", "edit"), async (req, res) => {
  try {
    const { agentName, department, breakStart, note, loggedBy } = req.body as {
      agentName: string; department: string;
      breakStart?: string; note?: string; loggedBy?: string;
    };
    if (!agentName || !department) {
      return res.status(400).json({ error: "agentName and department are required" });
    }
    const start = breakStart ? new Date(breakStart) : new Date();
    const [row] = await db.insert(agentBreaksTable).values({
      agentName: agentName.trim(),
      department: department.trim().toLowerCase(),
      breakStart: start,
      note: note?.trim() ?? null,
      loggedBy: loggedBy?.trim() ?? "self",
    }).returning();
    return res.json({ ok: true, break: row });
  } catch (err) {
    req.log.error(err, "breaks/start POST error");
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/breaks/end
 * Body: { id?, agentName?, breakEnd? }
 * Closes an open break session. Looks up by id OR by agentName (latest open).
 */
router.post("/breaks/end", requireAuth, requireRole("admin", "edit"), async (req, res) => {
  try {
    const { id, agentName, breakEnd } = req.body as {
      id?: number; agentName?: string; breakEnd?: string;
    };
    const end = breakEnd ? new Date(breakEnd) : new Date();

    if (id) {
      await db.update(agentBreaksTable)
        .set({ breakEnd: end })
        .where(eq(agentBreaksTable.id, id));
      return res.json({ ok: true });
    }

    if (agentName) {
      // Close the most recent open session for this agent
      const open = await db.select()
        .from(agentBreaksTable)
        .where(and(
          eq(agentBreaksTable.agentName, agentName.trim()),
          isNull(agentBreaksTable.breakEnd),
        ))
        .orderBy(desc(agentBreaksTable.breakStart))
        .limit(1);
      if (open.length === 0) return res.status(404).json({ error: "No open break found for this agent" });
      await db.update(agentBreaksTable)
        .set({ breakEnd: end })
        .where(eq(agentBreaksTable.id, open[0].id));
      return res.json({ ok: true, breakId: open[0].id });
    }

    return res.status(400).json({ error: "id or agentName required" });
  } catch (err) {
    req.log.error(err, "breaks/end POST error");
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/breaks/log
 * Body: { agentName, department, breakStart, breakEnd, note?, loggedBy? }
 * Log a complete break (start + end at once) — for external tools that submit after the fact.
 */
router.post("/breaks/log", requireAuth, requireRole("admin", "edit"), async (req, res) => {
  try {
    const { agentName, department, breakStart, breakEnd, note, loggedBy } = req.body as {
      agentName: string; department: string;
      breakStart: string; breakEnd: string;
      note?: string; loggedBy?: string;
    };
    if (!agentName || !department || !breakStart || !breakEnd) {
      return res.status(400).json({ error: "agentName, department, breakStart, and breakEnd are required" });
    }
    const [row] = await db.insert(agentBreaksTable).values({
      agentName: agentName.trim(),
      department: department.trim().toLowerCase(),
      breakStart: new Date(breakStart),
      breakEnd: new Date(breakEnd),
      note: note?.trim() ?? null,
      loggedBy: loggedBy?.trim() ?? "tool",
    }).returning();
    return res.json({ ok: true, break: row });
  } catch (err) {
    req.log.error(err, "breaks/log POST error");
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * DELETE /api/breaks/:id
 * Remove a break record.
 */
router.delete("/breaks/:id", requireAuth, requireRole("admin", "edit"), async (req, res) => {
  try {
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "");
    if (isNaN(id)) return res.status(400).json({ error: "invalid id" });
    await db.delete(agentBreaksTable).where(eq(agentBreaksTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "breaks DELETE error");
    return res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/breaks?from=YYYY-MM-DD&to=YYYY-MM-DD&agent=
 * List break records in a date range, optionally filtered by agent.
 */
router.get("/breaks", requireAuth, async (req, res) => {
  try {
    const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const from = ((req.query["from"] as string) || todayLA).slice(0, 10);
    const to   = ((req.query["to"]   as string) || todayLA).slice(0, 10);
    const agentFilter = req.query["agent"] as string | undefined;

    const rangeStart = new Date(from + "T07:00:00Z");
    if (rangeStart.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) !== from) {
      rangeStart.setTime(rangeStart.getTime() + 3600 * 1000);
    }
    const rangeEnd = new Date(to + "T07:00:00Z");
    if (rangeEnd.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) !== to) {
      rangeEnd.setTime(rangeEnd.getTime() + 3600 * 1000);
    }
    rangeEnd.setTime(rangeEnd.getTime() + 24 * 3600 * 1000 - 1);

    const conditions = [gte(agentBreaksTable.breakStart, rangeStart)];
    conditions.push(lte(agentBreaksTable.breakStart, rangeEnd));
    if (agentFilter) conditions.push(eq(agentBreaksTable.agentName, agentFilter));

    const rows = await db.select().from(agentBreaksTable)
      .where(and(...conditions))
      .orderBy(desc(agentBreaksTable.breakStart));

    return res.json({ breaks: rows });
  } catch (err) {
    req.log.error(err, "breaks GET error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
