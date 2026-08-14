import { Router, type NextFunction, type Request, type Response } from "express";
import { db, agentBreaksTable } from "@workspace/db";
import { and, eq, gte, lte, isNull, or, desc } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { canAccessAttendanceDepartment, canAccessDateRange, isAdministrator, isCanonicalUser } from "../middleware/authorizationCore.js";
import { businessDayWindow, formatCalendarDate, isCalendarDate } from "../lib/businessTime.js";
import { ATTENDANCE_MEMBER_ALIASES } from "../lib/attendancePolicy.js";
import {
  canAccessMetricAgent,
  loadAuthorizationAgentDirectory,
  type AuthorizationAgentDirectory,
} from "../lib/authorizationScope.js";
import type { AuthPayload } from "../middleware/authCore.js";

const router = Router();

function requireBreakEditor(req: Request, res: Response, next: NextFunction): void {
  const allowed = !!req.user && (
    isAdministrator(req.user)
    || (isCanonicalUser(req.user)
      ? req.user.permissions.includes("edit_attendance")
      : req.user.role === "edit")
  );
  if (!allowed) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

function canAccessBreakAgent(user: AuthPayload, agentName: string, directory: AuthorizationAgentDirectory): boolean {
  return [agentName, ...(ATTENDANCE_MEMBER_ALIASES[agentName] ?? [])]
    .some((name) => canAccessMetricAgent(user, name, directory));
}

/**
 * POST /api/breaks/start
 * Body: { agentName, department, breakStart?, note?, loggedBy? }
 * Opens a break session (breakEnd = null = still on break).
 */
router.post("/breaks/start", requireAuth, requireBreakEditor, async (req, res) => {
  try {
    const { agentName, department, breakStart, note, loggedBy } = req.body as {
      agentName: string; department: string;
      breakStart?: string; note?: string; loggedBy?: string;
    };
    if (!agentName || !department) {
      return res.status(400).json({ error: "agentName and department are required" });
    }
    const start = breakStart ? new Date(breakStart) : new Date();
    if (!Number.isFinite(start.getTime())) return res.status(400).json({ error: "Invalid breakStart." });
    const directory = await loadAuthorizationAgentDirectory();
    if (!canAccessAttendanceDepartment(req.user!, department)
      || !canAccessBreakAgent(req.user!, agentName, directory)
      || !canAccessDateRange(req.user!, [start.toISOString()])) {
      return res.status(403).json({ error: "Forbidden" });
    }
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
router.post("/breaks/end", requireAuth, requireBreakEditor, async (req, res) => {
  try {
    const { id, agentName, breakEnd } = req.body as {
      id?: number; agentName?: string; breakEnd?: string;
    };
    const end = breakEnd ? new Date(breakEnd) : new Date();
    if (!Number.isFinite(end.getTime())) return res.status(400).json({ error: "Invalid breakEnd." });

    if (id) {
      const [existing] = await db.select().from(agentBreaksTable).where(eq(agentBreaksTable.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: "Break not found" });
      const directory = await loadAuthorizationAgentDirectory();
      if (!canAccessAttendanceDepartment(req.user!, existing.department)
        || !canAccessBreakAgent(req.user!, existing.agentName, directory)
        || !canAccessDateRange(req.user!, [existing.breakStart.toISOString(), end.toISOString()])) {
        return res.status(403).json({ error: "Forbidden" });
      }
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
      const directory = await loadAuthorizationAgentDirectory();
      if (!canAccessAttendanceDepartment(req.user!, open[0]!.department)
        || !canAccessBreakAgent(req.user!, open[0]!.agentName, directory)
        || !canAccessDateRange(req.user!, [open[0]!.breakStart.toISOString(), end.toISOString()])) {
        return res.status(403).json({ error: "Forbidden" });
      }
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
router.post("/breaks/log", requireAuth, requireBreakEditor, async (req, res) => {
  try {
    const { agentName, department, breakStart, breakEnd, note, loggedBy } = req.body as {
      agentName: string; department: string;
      breakStart: string; breakEnd: string;
      note?: string; loggedBy?: string;
    };
    if (!agentName || !department || !breakStart || !breakEnd) {
      return res.status(400).json({ error: "agentName, department, breakStart, and breakEnd are required" });
    }
    const start = new Date(breakStart);
    const end = new Date(breakEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
      return res.status(400).json({ error: "Invalid break time range." });
    }
    const directory = await loadAuthorizationAgentDirectory();
    if (!canAccessAttendanceDepartment(req.user!, department)
      || !canAccessBreakAgent(req.user!, agentName, directory)
      || !canAccessDateRange(req.user!, [breakStart, breakEnd])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const [row] = await db.insert(agentBreaksTable).values({
      agentName: agentName.trim(),
      department: department.trim().toLowerCase(),
      breakStart: start,
      breakEnd: end,
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
router.delete("/breaks/:id", requireAuth, requireBreakEditor, async (req, res) => {
  try {
    const rawId = req.params.id;
    const id = parseInt(Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "");
    if (isNaN(id)) return res.status(400).json({ error: "invalid id" });
    const [existing] = await db.select().from(agentBreaksTable).where(eq(agentBreaksTable.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Break not found" });
    const directory = await loadAuthorizationAgentDirectory();
    if (!canAccessAttendanceDepartment(req.user!, existing.department)
      || !canAccessBreakAgent(req.user!, existing.agentName, directory)
      || !canAccessDateRange(req.user!, [existing.breakStart.toISOString()])) {
      return res.status(403).json({ error: "Forbidden" });
    }
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
    const todayLA = formatCalendarDate(new Date());
    const from = ((req.query["from"] as string) || todayLA).slice(0, 10);
    const to   = ((req.query["to"]   as string) || todayLA).slice(0, 10);
    const agentFilter = req.query["agent"] as string | undefined;
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
      return res.status(400).json({ error: "Invalid break date range." });
    }
    const directory = await loadAuthorizationAgentDirectory();
    if (!canAccessDateRange(req.user!, [from, to]) || (agentFilter && !canAccessBreakAgent(req.user!, agentFilter, directory))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const rangeStart = businessDayWindow(from).start;
    const rangeEnd = new Date(businessDayWindow(to).endExclusive.getTime() - 1);

    const conditions = [gte(agentBreaksTable.breakStart, rangeStart)];
    conditions.push(lte(agentBreaksTable.breakStart, rangeEnd));
    if (agentFilter) conditions.push(eq(agentBreaksTable.agentName, agentFilter));

    const rows = await db.select().from(agentBreaksTable)
      .where(and(...conditions))
      .orderBy(desc(agentBreaksTable.breakStart));

    const scopedRows = rows.filter((row) =>
      canAccessAttendanceDepartment(req.user!, row.department) && canAccessBreakAgent(req.user!, row.agentName, directory));
    return res.json({ breaks: scopedRows });
  } catch (err) {
    req.log.error(err, "breaks GET error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
