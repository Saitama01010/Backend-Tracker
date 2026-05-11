import { Router } from "express";
import { db, phoneCallsTable, attendanceMembersTable } from "@workspace/db";
import { and, gte, lte, or, eq } from "drizzle-orm";

const router = Router();

function laStartOfDay(dateStr: string): Date {
  const pdt = new Date(`${dateStr}T07:00:00Z`);
  if (pdt.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) === dateStr) return pdt;
  return new Date(`${dateStr}T08:00:00Z`);
}

function dateRangeLA(from: string, to: string): string[] {
  const dates: string[] = [];
  const cur = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

const MEMBER_TO_AGENT_NAMES: Record<string, string[]> = {
  "Levi Miller":      ["Levi Miller", "Ahmed Ayman"],
  "Rick Miller":      ["Rick Miller", "Zeiad Fouad"],
  "Jacob Stephenson": ["Jacob Stephenson", "Abdulrhman Isawi"],
  "Michael Belfort":  ["Michael Belfort", "Nouralden"],
  "Ryan Henderson":   ["Ryan Henderson", "Jacob Ahmed"],
  "Henry Hart":       ["Henry Hart", "Max Francis"],
  "Jacob Xander":     ["Jacob Xander", "Youssef Nady"],
};

function agentNamesForMember(name: string): string[] {
  return MEMBER_TO_AGENT_NAMES[name] ?? [name];
}

/**
 * GET /api/violations?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns two violation types for all active attendance members:
 *  - lateLogin:        first call > shift_start + 10 min
 *  - availabilityGaps: gaps > 5 min between consecutive calls within a shift window
 */
router.get("/violations", async (req, res) => {
  try {
    const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const from = ((req.query["from"] as string) || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).slice(0, 10);
    const to   = ((req.query["to"]   as string) || todayLA).slice(0, 10);

    const dates = dateRangeLA(from, to).filter((d) => d <= todayLA);
    if (dates.length === 0) {
      return res.json({ lateLogin: [], availabilityGaps: [] });
    }

    const rangeStart = laStartOfDay(dates[0]);
    const rangeEnd   = new Date(laStartOfDay(dates[dates.length - 1]).getTime() + 24 * 3600 * 1000 - 1);

    const members = await db
      .select()
      .from(attendanceMembersTable)
      .where(eq(attendanceMembersTable.active, true));

    const allAgentLower = new Set<string>();
    for (const m of members) {
      for (const n of agentNamesForMember(m.name)) allAgentLower.add(n.toLowerCase());
    }

    const rows = await db
      .select({
        agentName:       phoneCallsTable.agentName,
        direction:       phoneCallsTable.direction,
        status:          phoneCallsTable.status,
        createdAt:       phoneCallsTable.createdAt,
        durationSeconds: phoneCallsTable.durationSeconds,
      })
      .from(phoneCallsTable)
      .where(and(
        gte(phoneCallsTable.createdAt, rangeStart),
        lte(phoneCallsTable.createdAt, rangeEnd),
        or(
          eq(phoneCallsTable.direction, "outgoing"),
          and(eq(phoneCallsTable.direction, "incoming"), eq(phoneCallsTable.status, "completed")),
        ),
      ));

    const callsByAgentDate = new Map<string, Date[]>();
    for (const row of rows) {
      if (!row.agentName || !row.createdAt) continue;
      const lower = row.agentName.trim().toLowerCase();
      if (!allAgentLower.has(lower)) continue;
      const t = new Date(row.createdAt);
      const dateLA = t.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const key = `${lower}|${dateLA}`;
      const arr = callsByAgentDate.get(key) ?? [];
      arr.push(t);
      callsByAgentDate.set(key, arr);
    }
    for (const arr of callsByAgentDate.values()) arr.sort((a, b) => a.getTime() - b.getTime());

    const nowUtc = new Date();

    type LateLoginRow = {
      member: string; department: string; date: string;
      shiftStart: string; firstCallAt: string; minutesLate: number;
    };
    type GapRow = {
      member: string; department: string; date: string;
      gapCount: number; gaps: { start: string; end: string; minutes: number }[];
    };

    const lateLogin: LateLoginRow[] = [];
    const availabilityGaps: GapRow[] = [];

    for (const date of dates) {
      const dayStart = laStartOfDay(date);
      for (const member of members) {
        const shiftNum = parseInt(member.shift || "0");
        if (!shiftNum) continue;
        const shiftStartUtc = new Date(dayStart.getTime() + shiftNum * 3600 * 1000);
        if (shiftStartUtc > nowUtc) continue;

        const memberNames = agentNamesForMember(member.name);
        const allCalls: Date[] = [];
        for (const n of memberNames) {
          const key = `${n.toLowerCase()}|${date}`;
          for (const t of callsByAgentDate.get(key) ?? []) allCalls.push(t);
        }
        allCalls.sort((a, b) => a.getTime() - b.getTime());

        const callsFromDayStart = allCalls.filter((t) => t >= dayStart);

        // ── Late Login ─────────────────────────────────────────────
        const firstCall = callsFromDayStart[0] ?? null;
        if (firstCall) {
          const minsLate = Math.round((firstCall.getTime() - shiftStartUtc.getTime()) / 60000);
          if (minsLate > 10) {
            lateLogin.push({
              member: member.name,
              department: member.department,
              date,
              shiftStart: shiftStartUtc.toISOString(),
              firstCallAt: firstCall.toISOString(),
              minutesLate: minsLate,
            });
          }
        }

        // ── Availability Gaps (> 5 min between consecutive calls) ──
        const shiftEndUtc = new Date(shiftStartUtc.getTime() + 10 * 3600 * 1000);
        const shiftCalls  = allCalls.filter((t) => t >= shiftStartUtc && t <= shiftEndUtc);
        if (shiftCalls.length < 2) continue;

        const gaps: { start: string; end: string; minutes: number }[] = [];
        for (let i = 0; i < shiftCalls.length - 1; i++) {
          const gapMins = Math.round((shiftCalls[i + 1].getTime() - shiftCalls[i].getTime()) / 60000);
          if (gapMins > 5) {
            gaps.push({
              start:   shiftCalls[i].toISOString(),
              end:     shiftCalls[i + 1].toISOString(),
              minutes: gapMins,
            });
          }
        }
        if (gaps.length > 0) {
          availabilityGaps.push({
            member: member.name,
            department: member.department,
            date,
            gapCount: gaps.length,
            gaps,
          });
        }
      }
    }

    return res.json({ lateLogin, availabilityGaps });
  } catch (err) {
    req.log.error(err, "violations error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
