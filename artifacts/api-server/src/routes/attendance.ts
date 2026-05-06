import { Router } from "express";
import { db } from "@workspace/db";
import {
  attendanceMembersTable,
  attendanceRecordsTable,
} from "@workspace/db";
import { eq, and, gte, lte, inArray } from "drizzle-orm";

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

export default router;
