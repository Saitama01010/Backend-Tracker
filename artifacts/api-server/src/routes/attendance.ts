import { Router } from "express";
import { db, phoneCallsTable } from "@workspace/db";
import {
  attendanceMembersTable,
  attendanceRecordsTable,
} from "@workspace/db";
import { eq, and, gte, lte, inArray, min } from "drizzle-orm";
import { getCallHistoryCache } from "./vos";

const router = Router();

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
  return "";
}

router.get("/attendance", async (req, res) => {
  try {
    const from = (req.query["from"] as string) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = (req.query["to"] as string) || new Date().toISOString().slice(0, 10);

    const members = await db
      .select()
      .from(attendanceMembersTable)
      .where(eq(attendanceMembersTable.active, true))
      .orderBy(attendanceMembersTable.department, attendanceMembersTable.name);

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

    res.json({ members, records });
  } catch (err) {
    req.log.error(err, "attendance GET error");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/attendance/members", async (req, res) => {
  try {
    const { name, shift, department } = req.body as { name: string; shift?: string; department?: string };
    if (!name?.trim()) return res.status(400).json({ error: "name required" });
    const [member] = await db
      .insert(attendanceMembersTable)
      .values({ name: name.trim(), shift: shift?.trim() ?? "", department: department?.trim() ?? "" })
      .returning();
    res.json(member);
  } catch (err) {
    req.log.error(err, "attendance POST member error");
    res.status(500).json({ error: String(err) });
  }
});

router.patch("/attendance/members/:id", async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    const body = req.body as Partial<{ name: string; shift: string; department: string; active: boolean }>;
    const upd: Partial<{ name: string; shift: string; department: string; active: boolean }> = {};
    if (body.name !== undefined) upd.name = body.name.trim();
    if (body.shift !== undefined) upd.shift = body.shift.trim();
    if (body.department !== undefined) upd.department = body.department.trim();
    if (body.active !== undefined) upd.active = body.active;
    const [member] = await db.update(attendanceMembersTable).set(upd).where(eq(attendanceMembersTable.id, id)).returning();
    res.json(member);
  } catch (err) {
    req.log.error(err, "attendance PATCH member error");
    res.status(500).json({ error: String(err) });
  }
});

router.put("/attendance/record", async (req, res) => {
  try {
    const { memberId, date, status, note, coaching } = req.body as {
      memberId: number; date: string; status: string; note?: string; coaching?: boolean;
    };
    if (!memberId || !date) return res.status(400).json({ error: "memberId and date required" });
    const [record] = await db
      .insert(attendanceRecordsTable)
      .values({ memberId, date, status: status ?? "", note: note ?? null, coaching: coaching ?? false })
      .onConflictDoUpdate({
        target: [attendanceRecordsTable.memberId, attendanceRecordsTable.date],
        set: { status: status ?? "", note: note ?? null, coaching: coaching ?? false, updatedAt: new Date() },
      })
      .returning();
    res.json(record);
  } catch (err) {
    req.log.error(err, "attendance PUT record error");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/attendance/import", async (req, res) => {
  try {
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

    let totalMembers = 0;
    let totalRecords = 0;

    for (const { url, department } of SHEETS) {
      const text = await (await fetch(url)).text();
      const rows = parseCSV(text);
      if (rows.length < 2) continue;

      const header = rows[0];
      const dateIndices: { idx: number; iso: string }[] = [];
      for (let i = 2; i < header.length; i++) {
        const iso = parseSheetDate(header[i] ?? "");
        if (iso) dateIndices.push({ idx: i, iso });
      }

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const shift = row[0]?.trim() ?? "";
        const name = row[1]?.trim() ?? "";
        if (!name || !shift || shift === '"' || name.toUpperCase() === "NA" || !/^\d+$/.test(shift)) continue;

        const existing = await db
          .select()
          .from(attendanceMembersTable)
          .where(and(eq(attendanceMembersTable.name, name), eq(attendanceMembersTable.department, department)))
          .limit(1);

        let memberId: number;
        if (existing.length > 0) {
          memberId = existing[0].id;
        } else {
          const [inserted] = await db
            .insert(attendanceMembersTable)
            .values({ name, shift, department })
            .returning();
          memberId = inserted.id;
          totalMembers++;
        }

        for (const { idx, iso } of dateIndices) {
          const rawStatus = row[idx]?.trim() ?? "";
          const status = normalizeStatus(rawStatus);
          if (!rawStatus) continue;
          await db
            .insert(attendanceRecordsTable)
            .values({ memberId, date: iso, status })
            .onConflictDoNothing();
          totalRecords++;
        }
      }
    }

    res.json({ success: true, totalMembers, totalRecords });
  } catch (err) {
    req.log.error(err, "attendance import error");
    res.status(500).json({ error: String(err) });
  }
});

// ─── Auto-mark attendance from first call of the day ─────────────────────────
//
// Shift N = N PM Egypt time (UTC+2) → UTC hour = N + 10
// (e.g. shift 4 = 4 PM Egypt = 14:00 UTC, shift 8 = 8 PM Egypt = 18:00 UTC)
//
// Mapping from attendance member name → VoS/PBX agent display names used in
// call history. Only needed where the name doesn't match directly.
const MEMBER_TO_AGENT_NAMES: Record<string, string[]> = {
  "Ahmed Ayman-Levi Miller":         ["Levi Miller", "Ahmed Ayman"],
  "Zeiad Fouad-Zack Ford":           ["Rick Miller", "Zeiad Fouad"],
  "Abdlrhman-Jacob Stephenson":      ["Jacob Stephenson", "Abdulrhman Isawi"],
  "Nour-Michael Belfort-2900":       ["Michael Belfort", "Nouralden"],
  "Jacob Ahmed":                     ["Ryan Henderson", "Jacob Ahmed"],
  "Mohammed Ayman-Max Francis-2268": ["Henry Hart", "Max Francis"],
  "Youssef Nady-Jacob Xander":       ["Jacob Xander", "Youssef Nady"],
};

function lateNote(minsLate: number): string {
  if (minsLate < 60) return `late ${minsLate}min`;
  const h = Math.floor(minsLate / 60);
  const m = minsLate % 60;
  return m > 0 ? `late ${h}h ${m}min` : `late ${h}h`;
}

// VoS/PBX timestamps have no timezone indicator and are in PDT (UTC-7).
// Quo DB timestamps are stored as UTC (TIMESTAMPTZ from OpenPhone API).
// Egypt is UTC+2. Attendance sheet dates are Egypt time.
function parsePdt(s: string): Date {
  // If the string already has a timezone (+, -, or Z) treat it as-is.
  if (/[Z+]/.test(s) || (s.includes('-') && s.lastIndexOf('-') > 7)) return new Date(s);
  return new Date(s + '-07:00');
}

router.post("/attendance/auto-mark", async (req, res) => {
  try {
    // Today's date in Egypt timezone (UTC+2)
    const nowUtc = new Date();
    const egyptOffsetMs = 2 * 60 * 60 * 1000;
    const egyptNow = new Date(nowUtc.getTime() + egyptOffsetMs);
    const todayEgypt = egyptNow.toISOString().slice(0, 10);

    // Egypt day window in UTC:
    //   midnight Egypt (UTC+2) = todayEgypt T00:00+02:00 = todayEgypt-1 T22:00Z
    //   end of Egypt day       = todayEgypt T23:59:59+02:00
    const dayStartUtc = new Date(`${todayEgypt}T00:00:00+02:00`);
    const dayEndUtc   = new Date(`${todayEgypt}T23:59:59+02:00`);

    // Build VoS first-call map: agentName (lowercase) → Date (UTC)
    // VoS timestamps are PDT strings (no timezone). Interpret as UTC-7.
    // Only include calls that fall within today's Egypt day window.
    const vosFirstCall = new Map<string, Date>();
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

    // Query Quo DB for first call per agentName today.
    // Quo DB stores UTC timestamps (TIMESTAMPTZ), so compare directly with the Egypt day window.
    const quoRows = await db
      .select({
        agentName: phoneCallsTable.agentName,
        firstCallAt: min(phoneCallsTable.createdAt),
      })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.createdAt, dayStartUtc), lte(phoneCallsTable.createdAt, dayEndUtc)))
      .groupBy(phoneCallsTable.agentName);

    const quoFirstCall = new Map<string, Date>();
    for (const row of quoRows) {
      if (row.agentName && row.firstCallAt) {
        quoFirstCall.set(row.agentName.trim().toLowerCase(), new Date(row.firstCallAt));
      }
    }

    // Fetch all active members
    const members = await db
      .select()
      .from(attendanceMembersTable)
      .where(eq(attendanceMembersTable.active, true));

    // Fetch existing records for today (to avoid overwriting manual entries)
    const existingRecords = await db
      .select()
      .from(attendanceRecordsTable)
      .where(eq(attendanceRecordsTable.date, todayEgypt));
    const existingSet = new Set(existingRecords.map((r) => r.memberId));

    const results: { name: string; status: string; note: string; skipped?: string }[] = [];

    for (const member of members) {
      const shiftNum = parseInt(member.shift || "0");
      if (!shiftNum) { results.push({ name: member.name, status: "", note: "", skipped: "no shift" }); continue; }

      // Shift start in UTC: shift N PM Egypt = (N+12) hour Egypt = (N+12-2) hour UTC = (N+10) UTC
      const shiftStartUtcHour = shiftNum + 10; // e.g. shift 4 → 14 UTC
      const shiftStartUtc = new Date(`${todayEgypt}T${String(shiftStartUtcHour).padStart(2, "0")}:00:00Z`);

      // Only auto-mark if the shift has already started
      if (nowUtc < shiftStartUtc) {
        results.push({ name: member.name, status: "", note: "", skipped: "shift not started yet" });
        continue;
      }

      // Don't overwrite manual entries
      if (existingSet.has(member.id)) {
        results.push({ name: member.name, status: "", note: "", skipped: "already has record" });
        continue;
      }

      // Resolve VoS/Quo agent names for this member
      const agentNames: string[] = MEMBER_TO_AGENT_NAMES[member.name]
        ?? [member.name.split("-")[0].trim(), member.name];
      const agentNamesLower = agentNames.map((n) => n.trim().toLowerCase());

      // Find earliest first call across all known names.
      // vosFirstCall values are already Date (parsed as PDT → UTC).
      // quoFirstCall values are already Date (UTC from DB).
      let firstCallAt: Date | null = null;
      for (const nameLower of agentNamesLower) {
        const vos = vosFirstCall.get(nameLower);
        if (vos && (!firstCallAt || vos < firstCallAt)) firstCallAt = vos;
        const quo = quoFirstCall.get(nameLower);
        if (quo && (!firstCallAt || quo < firstCallAt)) firstCallAt = quo;
      }

      if (!firstCallAt) {
        results.push({ name: member.name, status: "", note: "", skipped: "no calls today" });
        continue;
      }

      const minsLate = Math.round((firstCallAt.getTime() - shiftStartUtc.getTime()) / 60000);
      const GRACE_MINS = 10;

      let status: string;
      let note: string;
      if (minsLate <= GRACE_MINS) {
        status = "in";
        note = "";
      } else {
        status = "late";
        note = lateNote(minsLate);
      }

      await db
        .insert(attendanceRecordsTable)
        .values({ memberId: member.id, date: todayEgypt, status, note: note || null, coaching: false })
        .onConflictDoNothing();

      results.push({ name: member.name, status, note });
    }

    res.json({ success: true, date: todayEgypt, results });
  } catch (err) {
    req.log.error(err, "attendance auto-mark error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
