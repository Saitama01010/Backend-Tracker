import { Router } from "express";
import { db, phoneCallsTable } from "@workspace/db";
import {
  attendanceMembersTable,
  attendanceRecordsTable,
} from "@workspace/db";
import { eq, and, or, gte, lte, inArray, ilike, isNotNull, sql } from "drizzle-orm";
import { getCallHistoryCache, hydrateVosState } from "./vos";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import {
  ATTENDANCE_MEMBER_ALIASES,
  ATTENDANCE_TIMEZONE,
  addAttendanceCalendarDays,
  attendanceDate,
  attendanceStartOfDay,
  type AttendanceStatus,
} from "../lib/attendancePolicy.js";
import {
  activeAttendanceMembers,
  resolveActiveAttendanceMember,
  resolveActiveAttendanceMemberFromList,
  setAttendanceRecord,
  setAttendanceRecords,
} from "../lib/attendanceService.js";
import {
  attendanceImportMemberKey,
  buildAttendanceImportPlan,
  buildQuoFirstCallMap,
  type AttendanceImportCandidate,
} from "../lib/databasePerformance.js";
import {
  attendanceDepartmentForUser,
  canAccessAgent,
  canAccessAttendanceDepartment,
  canAccessDateRange,
  hasPermission,
} from "../middleware/authorizationCore.js";
import type { AuthPayload } from "../middleware/authCore.js";
import { canAccessLiveAgent, loadAuthorizationAgentDirectory } from "../lib/authorizationScope.js";
import {
  escapeLikePattern,
  validateOptionalWorkflowRange,
  validateWorkflowCalendarDate,
} from "../lib/sensitiveWorkflowPolicy.js";

const router = Router();
router.use("/attendance", requireAuth);

class AttendanceImportSourceError extends Error {}

const MONTH_MAP: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function parseSheetDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const mon = MONTH_MAP[m[2]];
  if (!mon) return null;
  const day = m[1].padStart(2, "0");
  return `2026-${mon}-${day}`;
}

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { cells.push(cur); cur = ""; }
      else { cur += ch; }
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

function normalizeStatus(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === "in") return "in";
  if (s === "off") return "off";
  if (s === "late") return "late";
  if (s === "pto") return "pto";
  if (s === "absent") return "absent";
  if (s === "nsnc") return "nsnc";
  return "";
}

// ─── Timezone helpers ─────────────────────────────────────────────────────────
//
// All attendance dates and shift times are in America/Los_Angeles (PDT/PST).
// Shift N = N:00 LA time (24-hour). E.g. shift 15 = 3:00 PM PDT.
//
// Quo DB timestamps are UTC (TIMESTAMPTZ). VoS/PBX timestamps are PDT (no TZ
// indicator, parsePdt appends -07:00). Both are compared against UTC windows.

// Returns the UTC instant corresponding to midnight (00:00:00) in LA time
// for the given YYYY-MM-DD date string. Handles PDT (UTC-7) and PST (UTC-8).
const laStartOfDay = attendanceStartOfDay;

// Today's date string in LA time.
function todayLA(): string {
  return attendanceDate();
}

function canAccessAttendanceMember(
  user: AuthPayload,
  member: { name: string; department: string },
): boolean {
  return canAccessAttendanceDepartment(user, member.department)
    && canAccessAgent(user, member.name, ATTENDANCE_MEMBER_ALIASES[member.name] ?? []);
}

router.get("/attendance", async (req, res) => {
  try {
    const from = (req.query["from"] as string) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = (req.query["to"] as string) || new Date().toISOString().slice(0, 10);
    const requestedRange = validateOptionalWorkflowRange(from, to);
    if (!requestedRange.ok) {
      res.status(400).json({ error: requestedRange.error });
      return;
    }
    const includeInactive = req.query["includeInactive"] === "true";
    if (!canAccessDateRange(req.user!, [from, to]) || (includeInactive && !hasPermission(req.user!, "manage_members"))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const allMembers = await db
      .select()
      .from(attendanceMembersTable)
      .where(includeInactive ? undefined : eq(attendanceMembersTable.active, true))
      .orderBy(attendanceMembersTable.department, attendanceMembersTable.name);

    const members = allMembers.filter((member) => canAccessAttendanceMember(req.user!, member));
    const records =
      members.length > 0
        ? await db
            .select()
            .from(attendanceRecordsTable)
            .where(
              and(
                inArray(attendanceRecordsTable.memberId, members.map((m) => m.id)),
                gte(attendanceRecordsTable.date, from),
                lte(attendanceRecordsTable.date, to),
              ),
            )
        : [];

    res.json({ members, records, timezone: ATTENDANCE_TIMEZONE });
  } catch (err) {
    req.log.error(err, "attendance GET error");
    res.status(500).json({ error: "Unable to load attendance." });
  }
});

router.post("/attendance/members", requireAuth, requirePermission("manage_members"), async (req, res) => {
  try {
    const { name, shift, shiftHours, department } = req.body as { name: string; shift?: string; shiftHours?: string; department?: string };
    if (!name?.trim()) {
      res.status(400).json({ error: "name required" });
      return;
    }
    if (!canAccessAttendanceMember(req.user!, { name: name.trim(), department: department?.trim() ?? "" })) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const [member] = await db
      .insert(attendanceMembersTable)
      .values({ name: name.trim(), shift: shift?.trim() ?? "", shiftHours: shiftHours?.trim() ?? "8", department: department?.trim() ?? "" })
      .returning();
    res.json(member);
  } catch (err) {
    req.log.error(err, "attendance POST member error");
    res.status(500).json({ error: "Unable to create attendance member." });
  }
});

router.patch("/attendance/members/:id", requireAuth, requirePermission("manage_members"), async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid attendance member id." });
      return;
    }
    const body = req.body as Partial<{ name: string; shift: string; shiftHours: string; department: string; active: boolean }>;
    const [existing] = await db.select().from(attendanceMembersTable).where(eq(attendanceMembersTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Attendance member not found" });
      return;
    }
    const finalDepartment = body.department?.trim() ?? existing.department;
    const finalName = body.name?.trim() ?? existing.name;
    if (!canAccessAttendanceMember(req.user!, existing)
      || !canAccessAttendanceMember(req.user!, { name: finalName, department: finalDepartment })) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const upd: Partial<{ name: string; shift: string; shiftHours: string; department: string; active: boolean }> = {};
    if (body.name !== undefined) upd.name = body.name.trim();
    if (body.shift !== undefined) upd.shift = body.shift.trim();
    if (body.shiftHours !== undefined) upd.shiftHours = body.shiftHours.trim();
    if (body.department !== undefined) upd.department = body.department.trim();
    if (body.active !== undefined) upd.active = body.active;
    const [member] = await db.update(attendanceMembersTable).set(upd).where(eq(attendanceMembersTable.id, id)).returning();
    res.json(member);
  } catch (err) {
    req.log.error(err, "attendance PATCH member error");
    res.status(500).json({ error: "Unable to update attendance member." });
  }
});

router.put("/attendance/record", requireAuth, requirePermission("edit_attendance"), async (req, res) => {
  try {
    const { memberId, date, status, note, coaching } = req.body as {
      memberId: number; date: string; status: string; note?: string; coaching?: boolean;
    };
    if (!memberId || !validateWorkflowCalendarDate(date)) {
      res.status(400).json({ error: "memberId and date required" });
      return;
    }
    if (!canAccessDateRange(req.user!, [date])) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const resolved = await resolveActiveAttendanceMember(memberId);
    if (resolved.kind === "missing") return res.status(404).json({ error: "Attendance member not found" });
    if (resolved.kind === "ambiguous") return res.status(409).json({ error: "Attendance member is ambiguous" });
    if (!canAccessAttendanceMember(req.user!, resolved.member)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const result = await setAttendanceRecord({
      memberId,
      date,
      status: status as AttendanceStatus,
      note: note ?? null,
      coaching: coaching ?? false,
      overwrite: true,
    });
    if (result.kind === "member_missing") return res.status(404).json({ error: "Attendance member not found" });
    if (result.kind === "member_ambiguous") return res.status(409).json({ error: "Attendance member is ambiguous" });
    if (result.kind === "conflict") return res.status(409).json({ error: "Conflicting attendance record" });
    return res.json(result.record);
  } catch (err) {
    req.log.error(err, "attendance PUT record error");
    const invalid = (err as Error).message.includes("invalid");
    return res.status(invalid ? 400 : 500).json({ error: invalid ? "Invalid attendance record." : "Unable to update attendance." });
  }
});

router.post("/attendance/import", requireAuth, requirePermission("manage_members"), async (req, res) => {
  try {
    if (attendanceDepartmentForUser(req.user!) || req.user!.allowedAgents?.length) {
      res.status(403).json({ error: "Forbidden", reason: "The attendance import spans multiple departments." });
      return;
    }
    const SHEETS = [
      {
        url: "https://docs.google.com/spreadsheets/d/16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38/export?format=csv&gid=2116872008",
        department: "CS",
      },
      {
        url: "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=655352634",
        department: "Backend",
      },
    ];

    const sourceRows = await Promise.all(SHEETS.map(async ({ url, department }) => {
      const response = await fetch(url);
      if (!response.ok) throw new AttendanceImportSourceError();
      const rows = parseCSV(await response.text());
      if (rows.length < 2 || rows[0].length < 3) throw new AttendanceImportSourceError();
      return { rows, department };
    }));

    const importCandidates: AttendanceImportCandidate[] = [];

    for (const { rows, department } of sourceRows) {

      const header = rows[0];
      const dateIndices: { idx: number; iso: string }[] = [];
      for (let i = 2; i < header.length; i++) {
        const iso = parseSheetDate(header[i] ?? "");
        if (iso) dateIndices.push({ idx: i, iso });
      }
      if (dateIndices.length === 0) throw new AttendanceImportSourceError();

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const shift = row[0]?.trim() ?? "";
        const name = row[1]?.trim() ?? "";
        if (!name || !shift || shift === '"' || name.toUpperCase() === "NA" || !/^\d+$/.test(shift)) continue;

        const records: Array<{ date: string; status: string }> = [];
        for (const { idx, iso } of dateIndices) {
          const rawStatus = row[idx]?.trim() ?? "";
          const status = normalizeStatus(rawStatus);
          if (!rawStatus) continue;
          records.push({ date: iso, status });
        }
        importCandidates.push({ name, shift, department, records });
      }
    }

    const importPlan = buildAttendanceImportPlan(importCandidates);
    const importedMembers = new Map(importPlan.members.map((member) => [member.key, member]));
    const totalRecords = importPlan.totalRecords;

    const totalMembers = await db.transaction(async (tx) => {
      const existingMembers = await tx.select().from(attendanceMembersTable)
        .orderBy(attendanceMembersTable.id);
      const memberIds = new Map<string, number>();
      for (const member of existingMembers) {
        const key = attendanceImportMemberKey(member.department, member.name);
        if (!memberIds.has(key)) memberIds.set(key, member.id);
      }

      const missingMembers = [...importedMembers].filter(([key]) => !memberIds.has(key));
      if (missingMembers.length > 0) {
        const insertedMembers = await tx.insert(attendanceMembersTable)
          .values(missingMembers.map(([, member]) => ({
            name: member.name,
            shift: member.shift,
            department: member.department,
          })))
          .returning({
            id: attendanceMembersTable.id,
            name: attendanceMembersTable.name,
            department: attendanceMembersTable.department,
        });
        for (const member of insertedMembers) {
          memberIds.set(attendanceImportMemberKey(member.department, member.name), member.id);
        }
      }

      const pendingRecords = [...importedMembers].flatMap(([key, member]) => {
        const memberId = memberIds.get(key);
        if (memberId === undefined) throw new Error("Attendance import member persistence failed");
        return member.records.map((record) => ({ memberId, ...record }));
      });
      const chunkSize = 500;
      for (let offset = 0; offset < pendingRecords.length; offset += chunkSize) {
        await tx.insert(attendanceRecordsTable)
          .values(pendingRecords.slice(offset, offset + chunkSize))
          .onConflictDoNothing();
      }
      return missingMembers.length;
    });

    res.json({ success: true, totalMembers, totalRecords });
  } catch (err) {
    req.log.error(err, "attendance import error");
    const upstreamFailure = err instanceof AttendanceImportSourceError;
    res.status(upstreamFailure ? 502 : 500).json({
      error: upstreamFailure ? "Attendance import source is unavailable or invalid." : "Unable to import attendance.",
    });
  }
});

// ─── Helpers shared by auto-mark and call-logs ───────────────────────────────
//
// Shift N = N:00 LA time (24-hour). E.g. shift 15 = 3:00 PM PDT, shift 19 = 7:00 PM PDT.
// shiftStartUtc = laStartOfDay(date) + shiftNum * 3600 * 1000
//
// Mapping from attendance member name → VoS/PBX agent display names used in
// call history. Only needed where the name doesn't match directly.
const MEMBER_TO_AGENT_NAMES = ATTENDANCE_MEMBER_ALIASES;

function lateNote(minsLate: number): string {
  if (minsLate < 60) return `late ${minsLate}min`;
  const h = Math.floor(minsLate / 60);
  const m = minsLate % 60;
  return m > 0 ? `late ${h}h ${m}min` : `late ${h}h`;
}

// VoS/PBX timestamps have no timezone indicator and are in PDT (UTC-7).
// Quo DB timestamps are stored as UTC (TIMESTAMPTZ from OpenPhone API).
function parsePdt(s: string): Date {
  // If the string already has a timezone (+, -, or Z) treat it as-is.
  if (/[Z+]/.test(s) || (s.includes('-') && s.lastIndexOf('-') > 7)) return new Date(s);
  return new Date(s + '-07:00');
}

// Build a Quo calls map: agentName (lowercase) → all call timestamps within the day window.
// Only counts valid attendance signals:
//   - Outbound calls (agent dialed out, any status)
//   - Inbound calls answered by the agent (direction=incoming, status=completed)
async function buildQuoCallsMap(dayStartUtc: Date, dayEndUtc: Date): Promise<Map<string, Date>> {
  const rows = await db
    .select({
      agentName: phoneCallsTable.agentName,
      firstCallAt: sql<Date | null>`min(${phoneCallsTable.createdAt})`,
    })
    .from(phoneCallsTable)
    .where(
      and(
        gte(phoneCallsTable.createdAt, dayStartUtc),
        lte(phoneCallsTable.createdAt, dayEndUtc),
        isNotNull(phoneCallsTable.agentName),
        or(
          eq(phoneCallsTable.direction, "outgoing"),
          and(eq(phoneCallsTable.direction, "incoming"), eq(phoneCallsTable.status, "completed")),
        ),
      ),
    )
    .groupBy(phoneCallsTable.agentName);
  return buildQuoFirstCallMap(rows);
}

// Find the earliest call for a member within the LA calendar day.
// Uses dayStartUtc as the floor so agents who log in before their scheduled
// shift are still detected as present.
// shiftStartUtc=null means no shift — return null.
function resolveFirstCall(
  member: { name: string },
  dayStartUtc: Date,
  shiftStartUtc: Date | null,
  vosFirstCall: Map<string, Date>,
  quoCalls: Map<string, Date>,
): Date | null {
  if (!shiftStartUtc) return null;
  const floor = dayStartUtc;

  const agentNames: string[] = MEMBER_TO_AGENT_NAMES[member.name]
    ?? [member.name.split("-")[0].trim(), member.name];

  let firstCallAt: Date | null = null;

  for (const nameLower of agentNames.map((n) => n.trim().toLowerCase())) {
    // VoS: single minimum value per agent — only use it if it's within the valid window
    const vos = vosFirstCall.get(nameLower);
    if (vos && vos >= floor && (!firstCallAt || vos < firstCallAt)) firstCallAt = vos;

    // Quo: SQL minimum per normalized raw agent name.
    const quo = quoCalls.get(nameLower);
    if (quo && quo >= floor && (!firstCallAt || quo < firstCallAt)) firstCallAt = quo;
  }
  return firstCallAt;
}

// ─── GET /attendance/call-logs?date=YYYY-MM-DD ───────────────────────────────
// Returns per-agent call data (first call time, shift info, existing record) for
// any date. date is YYYY-MM-DD in LA time. Defaults to today LA.
router.get("/attendance/call-logs", async (req, res) => {
  try {
    const nowUtc = new Date();
    const defaultDate = todayLA();
    const date = ((req.query["date"] as string) || defaultDate).trim();
    if (!validateWorkflowCalendarDate(date)) {
      res.status(400).json({ error: "Invalid attendance date." });
      return;
    }
    if (!canAccessDateRange(req.user!, [date])) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const dayStartUtc = laStartOfDay(date);
    const dayEndUtc = new Date(laStartOfDay(addAttendanceCalendarDays(date, 1)).getTime() - 1);
    const isToday = date === defaultDate;

    // VoS only has today's data; skip for historical dates.
    const vosFirstCall = new Map<string, Date>();
    if (isToday) {
      await hydrateVosState();
      for (const stat of getCallHistoryCache()) {
        if (stat.firstCallAt) {
          const d = parsePdt(stat.firstCallAt);
          if (d >= dayStartUtc && d <= dayEndUtc) {
            const key = stat.agentName.trim().toLowerCase();
            const existing = vosFirstCall.get(key);
            if (!existing || d < existing) vosFirstCall.set(key, d);
          }
        }
      }
    }

    const quoCalls = await buildQuoCallsMap(dayStartUtc, dayEndUtc);

    const members = (await db
      .select()
      .from(attendanceMembersTable)
      .where(eq(attendanceMembersTable.active, true))
      .orderBy(attendanceMembersTable.department, attendanceMembersTable.name))
      .filter((member) => canAccessAttendanceMember(req.user!, member));

    const existingRecords = members.length > 0
      ? await db.select().from(attendanceRecordsTable)
          .where(and(inArray(attendanceRecordsTable.memberId, members.map((m) => m.id)), eq(attendanceRecordsTable.date, date)))
      : [];
    const existingMap = new Map(existingRecords.map((r) => [r.memberId, r]));

    const agents = members.map((member) => {
      const shiftNum = parseInt(member.shift || "0");
      // Shift N = N PM Egypt time. Egypt = UTC+2, PDT = UTC-7 → subtract 9h → PDT hour = shiftNum + 3
      // e.g. shift 4 (4 PM EGY = 16:00 EGY) → 7:00 PDT; shift 8 → 11:00 PDT
      const pdtHour = shiftNum ? shiftNum + 3 : 0;
      const shiftStartUtc = pdtHour
        ? new Date(dayStartUtc.getTime() + pdtHour * 3600 * 1000)
        : null;
      // ISO string of shift start (for AI/display use)
      const shiftStartLA = shiftStartUtc ? shiftStartUtc.toISOString() : null;

      const firstCallAt = resolveFirstCall(member, dayStartUtc, shiftStartUtc, vosFirstCall, quoCalls);
      const minsLate = firstCallAt && shiftStartUtc
        ? Math.round((firstCallAt.getTime() - shiftStartUtc.getTime()) / 60000)
        : null;

      let autoStatus: string;
      if (!shiftNum) autoStatus = "no_shift";
      else if (firstCallAt === null) autoStatus = shiftStartUtc && nowUtc > shiftStartUtc ? "no_calls" : "shift_not_started";
      else autoStatus = (minsLate ?? 0) <= 10 ? "on_time" : "late";

      const existingRecord = existingMap.get(member.id) ?? null;
      return {
        memberId: member.id,
        memberName: member.name,
        department: member.department,
        shift: member.shift,
        shiftStartLA,
        firstCallAt: firstCallAt?.toISOString() ?? null,
        minsLate,
        autoStatus,
        existingRecord: existingRecord
          ? { status: existingRecord.status, note: existingRecord.note ?? "", coaching: existingRecord.coaching }
          : null,
      };
    });

    res.json({ date, agents });
  } catch (err) {
    req.log.error(err, "attendance call-logs error");
    res.status(500).json({ error: "Unable to load attendance call logs." });
  }
});

// ─── POST /attendance/set ────────────────────────────────────────────────────
// Batch-write attendance records. Used by Samia for historical dates.
// Pass force=true to overwrite existing records; otherwise existing records are skipped.
router.post("/attendance/set", requireAuth, requirePermission("edit_attendance"), async (req, res) => {
  try {
    const { records, force = false, confirmed = false } = req.body as {
      records: { date: string; memberId?: number; memberName?: string; status: string; note?: string; coaching?: boolean }[];
      force?: boolean;
      confirmed?: boolean;
    };
    if (!Array.isArray(records) || records.length === 0) {
      res.status(400).json({ error: "records array required" });
      return;
    }
    if (records.length > 1 && !confirmed) {
      return res.status(409).json({ error: "Bulk attendance changes require confirmed=true" });
    }
    if (records.some((record) => !validateWorkflowCalendarDate(record.date))) {
      return res.status(400).json({ error: "Invalid attendance date." });
    }
    if (!canAccessDateRange(req.user!, records.map((record) => record.date))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const members = await activeAttendanceMembers();
    for (const record of records) {
      const resolved = resolveActiveAttendanceMemberFromList(members, record.memberId, record.memberName);
      if (resolved.kind === "ambiguous") return res.status(409).json({ error: "Attendance member is ambiguous" });
      if (resolved.kind === "unique" && !canAccessAttendanceMember(req.user!, resolved.member)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const writeResults = await setAttendanceRecords(records.map((record) => ({
      memberId: record.memberId,
      memberName: record.memberName,
      date: record.date,
      status: record.status as AttendanceStatus,
      note: record.note,
      coaching: record.coaching,
      overwrite: force,
    })), members);
    type SetResult = { memberName: string; date: string; status: string; action: string };
    const results: SetResult[] = [];

    for (let index = 0; index < records.length; index++) {
      const rec = records[index]!;
      const result = writeResults[index]!;
      const requestedName = rec.memberName ?? `member #${rec.memberId ?? "unknown"}`;
      if (result.kind === "member_missing") {
        results.push({ memberName: requestedName, date: rec.date, status: rec.status, action: "skipped: member not found" });
      } else if (result.kind === "member_ambiguous") {
        return res.status(409).json({ error: "Attendance member is ambiguous" });
      } else if (result.kind === "conflict") {
        results.push({ memberName: result.member.name, date: rec.date, status: rec.status, action: `skipped: already ${result.existing.status} (use force=true to overwrite)` });
      } else {
        results.push({ memberName: result.member.name, date: rec.date, status: rec.status, action: result.action });
      }
    }

    return res.json({ success: true, results, timezone: ATTENDANCE_TIMEZONE });
  } catch (err) {
    req.log.error(err, "attendance set error");
    const invalid = (err as Error).message.includes("invalid");
    return res.status(invalid ? 400 : 500).json({ error: invalid ? "Invalid attendance record." : "Unable to set attendance." });
  }
});

// ─── POST /attendance/auto-mark ──────────────────────────────────────────────
// Accepts optional { date: "YYYY-MM-DD" } body (LA date).
// Defaults to today in LA time. For past dates, VoS is skipped (only Quo DB).
router.post("/attendance/auto-mark", requireAuth, requirePermission("edit_attendance"), async (req, res) => {
  try {
    const nowUtc = new Date();
    const defaultLADate = todayLA();
    const targetDate: string = ((req.body as { date?: string })?.date ?? defaultLADate).trim();
    if (!validateWorkflowCalendarDate(targetDate)) {
      res.status(400).json({ error: "Invalid attendance date." });
      return;
    }
    const isToday = targetDate === defaultLADate;
    if (!canAccessDateRange(req.user!, [targetDate])) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const dayStartUtc = laStartOfDay(targetDate);
    const dayEndUtc = new Date(laStartOfDay(addAttendanceCalendarDays(targetDate, 1)).getTime() - 1);

    // VoS only has today's live data; use it only for today.
    const vosFirstCall = new Map<string, Date>();
    if (isToday) {
      await hydrateVosState();
      for (const stat of getCallHistoryCache()) {
        if (stat.firstCallAt) {
          const d = parsePdt(stat.firstCallAt);
          if (d >= dayStartUtc && d <= dayEndUtc) {
            const key = stat.agentName.trim().toLowerCase();
            const existing = vosFirstCall.get(key);
            if (!existing || d < existing) vosFirstCall.set(key, d);
          }
        }
      }
    }

    const quoCalls = await buildQuoCallsMap(dayStartUtc, dayEndUtc);

    const members = (await db.select().from(attendanceMembersTable).where(eq(attendanceMembersTable.active, true)))
      .filter((member) => canAccessAttendanceMember(req.user!, member));

    const existingRecords = await db.select()
      .from(attendanceRecordsTable)
      .where(eq(attendanceRecordsTable.date, targetDate));
    const existingSet = new Set(existingRecords.map((r) => r.memberId));

    const results: { name: string; status: string; note: string; skipped?: string }[] = [];
    const pending: Array<typeof attendanceRecordsTable.$inferInsert> = [];

    for (const member of members) {
      const shiftNum = parseInt(member.shift || "0");
      if (!shiftNum) { results.push({ name: member.name, status: "", note: "", skipped: "no shift" }); continue; }

      // Shift N = N PM Egypt time. Egypt = UTC+2, PDT = UTC-7 → pdtHour = shiftNum + 3
      // e.g. shift 4 (4 PM EGY) → 7 AM PDT; shift 8 (8 PM EGY) → 11 AM PDT
      const pdtHour = shiftNum + 3;
      const shiftStartUtc = new Date(dayStartUtc.getTime() + pdtHour * 3600 * 1000);

      // For today: skip if shift hasn't started. For past dates: always process.
      if (isToday && nowUtc < shiftStartUtc) {
        results.push({ name: member.name, status: "", note: "", skipped: "shift not started yet" });
        continue;
      }

      if (existingSet.has(member.id)) {
        results.push({ name: member.name, status: "", note: "", skipped: "already has record" });
        continue;
      }

      const firstCallAt = resolveFirstCall(member, dayStartUtc, shiftStartUtc, vosFirstCall, quoCalls);

      if (!firstCallAt) {
        results.push({ name: member.name, status: "", note: "", skipped: "no calls found" });
        continue;
      }

      const minsLate = Math.round((firstCallAt.getTime() - shiftStartUtc.getTime()) / 60000);
      const GRACE_MINS = 10;
      const status = minsLate <= GRACE_MINS ? "in" : "late";
      const note   = minsLate <= GRACE_MINS ? "" : lateNote(minsLate);

      pending.push({ memberId: member.id, date: targetDate, status, note: note || null, coaching: false });
      results.push({ name: member.name, status, note });
    }

    if (pending.length > 0) {
      await db.insert(attendanceRecordsTable).values(pending).onConflictDoNothing();
    }

    res.json({ success: true, date: targetDate, results });
  } catch (err) {
    req.log.error(err, "attendance auto-mark error");
    res.status(500).json({ error: "Unable to auto-mark attendance." });
  }
});

// GET /api/attendance/agent-contacts?agent=&date=
// Returns unique phone numbers (participants) an agent spoke with on a given date.
// date is YYYY-MM-DD in LA time. agent is a partial, case-insensitive name.
router.get("/attendance/agent-contacts", async (req, res) => {
  try {
    const agentParam = ((req.query["agent"] as string) ?? "").trim();
    const dateParam  = ((req.query["date"]  as string) ?? "").trim();
    if (!agentParam) {
      return res.status(400).json({ error: "agent param is required" });
    }
    if (agentParam.length > 128 || (dateParam && !validateWorkflowCalendarDate(dateParam))) {
      return res.status(400).json({ error: "Invalid agent or attendance date." });
    }
    if (!canAccessDateRange(req.user!, [dateParam || todayLA()])) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now = new Date();
    let dayStartUtc: Date;
    let dayEndUtc: Date;
    let laDate: string;

    if (dateParam) {
      // Specific LA calendar day
      dayStartUtc = laStartOfDay(dateParam);
      dayEndUtc = new Date(laStartOfDay(addAttendanceCalendarDays(dateParam, 1)).getTime() - 1);
      laDate      = dateParam;
    } else {
      // "Today" = rolling 24h window ending now.
      // This captures the full current shift regardless of when it started —
      // night-shift calls that cross the LA calendar midnight are included.
      dayEndUtc   = now;
      dayStartUtc = new Date(now.getTime() - 24 * 3600 * 1000);
      laDate      = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    }

    // Fetch all matching rows from phone_calls
    const matchingRows = await db
      .select({
        participant:     phoneCallsTable.participant,
        direction:       phoneCallsTable.direction,
        status:          phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        createdAt:       phoneCallsTable.createdAt,
        agentName:       phoneCallsTable.agentName,
      })
      .from(phoneCallsTable)
      .where(
        and(
          ilike(phoneCallsTable.agentName, `%${escapeLikePattern(agentParam)}%`),
          gte(phoneCallsTable.createdAt, dayStartUtc),
          lte(phoneCallsTable.createdAt, dayEndUtc),
        ),
      )
      .orderBy(sql`${phoneCallsTable.createdAt} asc`);

    const directory = await loadAuthorizationAgentDirectory();
    const rows = matchingRows.filter((row) => !!row.agentName && canAccessLiveAgent(req.user!, row.agentName, directory));
    if (matchingRows.length > 0 && rows.length === 0) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Group by participant
    const contactMap = new Map<string, {
      participant: string;
      calls: number;
      answered: number;
      missed: number;
      totalSeconds: number;
      inbound: number;
      outbound: number;
      firstCallAt: string;
      lastCallAt: string;
    }>();

    for (const r of rows) {
      const key = r.participant;
      let entry = contactMap.get(key);
      if (!entry) {
        entry = {
          participant: key,
          calls: 0, answered: 0, missed: 0,
          totalSeconds: 0, inbound: 0, outbound: 0,
          firstCallAt: r.createdAt.toISOString(),
          lastCallAt:  r.createdAt.toISOString(),
        };
        contactMap.set(key, entry);
      }
      entry.calls++;
      entry.totalSeconds += r.durationSeconds ?? 0;
      if (r.status === "completed") entry.answered++;
      else entry.missed++;
      if (r.direction === "incoming") entry.inbound++;
      else entry.outbound++;
      if (r.createdAt < new Date(entry.firstCallAt)) entry.firstCallAt = r.createdAt.toISOString();
      if (r.createdAt > new Date(entry.lastCallAt))  entry.lastCallAt  = r.createdAt.toISOString();
    }

    const toLocalTime = (iso: string) => {
      const d = new Date(iso);
      const str = d.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "numeric", day: "numeric",
        hour: "numeric", minute: "2-digit",
        hour12: true,
      });
      // Append PDT or PST based on UTC offset at that instant
      const offset = d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" });
      const tz = offset.match(/P[SD]T/)?.[0] ?? "PT";
      return `${str} ${tz}`;
    };

    // Resolve distinct agents matched (for transparency)
    const agentNames = [...new Set(rows.map((r) => r.agentName).filter(Boolean))];
    const contacts = [...contactMap.values()]
      .sort((a, b) => b.calls - a.calls)
      .map((c) => ({
        ...c,
        firstCallAt: toLocalTime(c.firstCallAt),
        lastCallAt:  toLocalTime(c.lastCallAt),
      }));

    return res.json({
      agentQuery: agentParam,
      agentsMatched: agentNames,
      date: laDate,
      windowStart: toLocalTime(dayStartUtc.toISOString()),
      windowEnd:   toLocalTime(dayEndUtc.toISOString()),
      totalCalls: rows.length,
      uniqueContacts: contacts.length,
      contacts,
    });
  } catch (err) {
    req.log.error(err, "agent-contacts error");
    return res.status(500).json({ error: "Unable to load agent contacts." });
  }
});

export default router;
