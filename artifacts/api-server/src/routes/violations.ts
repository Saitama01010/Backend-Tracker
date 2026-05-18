import { Router } from "express";
import {
  db, phoneCallsTable, attendanceMembersTable,
  violationVerificationsTable, pbxMissedCallsTable,
} from "@workspace/db";
import { and, gte, lte, or, eq, inArray } from "drizzle-orm";

const TEAM_QUO_LINES = ["Retention", "CS Team", "Main NSF"];

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
  "Jacob Stephenson": ["Jacob Stephenson", "Abdulrhman Isawi", "Adam Maxwell"],
  "Michael Belfort":  ["Michael Belfort", "Nouralden"],
  "Ryan Henderson":   ["Ryan Henderson", "Jacob Ahmed"],
  "Henry Hart":       ["Henry Hart", "Max Francis"],
  "Jacob Xander":     ["Jacob Xander", "Youssef Nady"],
  "John Marcus":      ["John Marcus", "Youssef Nasser", "Youssef-John Marcus"],
};

function agentNamesForMember(name: string): string[] {
  return MEMBER_TO_AGENT_NAMES[name] ?? [name];
}

/** GET /api/violations?from=YYYY-MM-DD&to=YYYY-MM-DD */
router.get("/violations", async (req, res) => {
  try {
    const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const from = ((req.query["from"] as string) || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).slice(0, 10);
    const to   = ((req.query["to"]   as string) || todayLA).slice(0, 10);

    const dates = dateRangeLA(from, to).filter((d) => d <= todayLA);
    if (dates.length === 0) {
      return res.json({ lateLogin: [], availabilityGaps: [], missedWhileAvail: [], verifiedKeys: [] });
    }

    const rangeStart = laStartOfDay(dates[0]);
    const rangeEnd   = new Date(laStartOfDay(dates[dates.length - 1]).getTime() + 24 * 3600 * 1000 - 1);

    // Parallel fetch: members, verified keys, phone calls, missed PBX calls, missed Quo calls
    const [members, verifications, callRows, missedRows, quoMissedRows] = await Promise.all([
      db.select().from(attendanceMembersTable).where(eq(attendanceMembersTable.active, true)),
      db.select({ key: violationVerificationsTable.key }).from(violationVerificationsTable),
      db.select({
        agentName:           phoneCallsTable.agentName,
        direction:           phoneCallsTable.direction,
        status:              phoneCallsTable.status,
        createdAt:           phoneCallsTable.createdAt,
        durationSeconds:     phoneCallsTable.durationSeconds,
        ringDurationSeconds: phoneCallsTable.ringDurationSeconds,
      }).from(phoneCallsTable).where(and(
        gte(phoneCallsTable.createdAt, rangeStart),
        lte(phoneCallsTable.createdAt, rangeEnd),
        or(
          eq(phoneCallsTable.direction, "outgoing"),
          eq(phoneCallsTable.direction, "incoming"),
        ),
      )),
      db.select().from(pbxMissedCallsTable).where(and(
        gte(pbxMissedCallsTable.createdAt, rangeStart),
        lte(pbxMissedCallsTable.createdAt, rangeEnd),
        inArray(pbxMissedCallsTable.team, ["retention", "cs", "nsf"]),
      )),
      db.select({
        id:                  phoneCallsTable.id,
        participant:         phoneCallsTable.participant,
        lineTeam:            phoneCallsTable.lineTeam,
        lineName:            phoneCallsTable.lineName,
        createdAt:           phoneCallsTable.createdAt,
        status:              phoneCallsTable.status,
        durationSeconds:     phoneCallsTable.durationSeconds,
        ringDurationSeconds: phoneCallsTable.ringDurationSeconds,
      }).from(phoneCallsTable).where(and(
        gte(phoneCallsTable.createdAt, rangeStart),
        lte(phoneCallsTable.createdAt, rangeEnd),
        eq(phoneCallsTable.direction, "incoming"),
        inArray(phoneCallsTable.status, ["no-answer", "voicemail", "missed", "voicemail-brief"]),
        inArray(phoneCallsTable.lineName, TEAM_QUO_LINES),
      )),
    ]);

    const verifiedKeys = new Set(verifications.map((v) => v.key));

    const allAgentLower = new Set<string>();
    for (const m of members) {
      for (const n of agentNamesForMember(m.name)) allAgentLower.add(n.toLowerCase());
    }

    // ── Build per-agent call maps ─────────────────────────────────────────────
    // callsByAgentDate: for first-call and gap detection
    const callsByAgentDate = new Map<string, Date[]>();
    // agentCallSpans: for "was busy at time T" detection
    const agentCallSpans = new Map<string, { start: number; end: number }[]>();

    for (const row of callRows) {
      if (!row.agentName || !row.createdAt) continue;
      const lower = row.agentName.trim().toLowerCase();
      if (!allAgentLower.has(lower)) continue;
      // skip ghost calls — rang ≤2 seconds
      if (row.direction === "incoming") {
        const ringDur = row.ringDurationSeconds ?? ((row.durationSeconds ?? 0) === 0 ? 0 : 999);
        if (ringDur <= 2) continue;
      }
      const t = new Date(row.createdAt);

      // by-date map
      const dateLA = t.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const dateKey = `${lower}|${dateLA}`;
      const dateArr = callsByAgentDate.get(dateKey) ?? [];
      dateArr.push(t);
      callsByAgentDate.set(dateKey, dateArr);

      // spans map for busy check
      // in-progress calls have duration=0; use 30-min fallback so they register as busy
      const INPROGRESS_FALLBACK_S = 1800;
      const dur = (row.durationSeconds && row.durationSeconds > 0)
        ? row.durationSeconds
        : (row.status === "in-progress" ? INPROGRESS_FALLBACK_S : 0);
      const spanStart = t.getTime();
      const spanEnd   = spanStart + dur * 1000;
      if (spanEnd > spanStart) {
        const spanArr = agentCallSpans.get(lower) ?? [];
        spanArr.push({ start: spanStart, end: spanEnd });
        agentCallSpans.set(lower, spanArr);
      }
    }
    for (const arr of callsByAgentDate.values()) arr.sort((a, b) => a.getTime() - b.getTime());

    function isAgentBusy(agentLower: string, atMs: number): boolean {
      return (agentCallSpans.get(agentLower) ?? []).some((s) => s.start <= atMs && s.end >= atMs);
    }

    const nowUtc = new Date();

    type LateLoginRow = {
      key: string; member: string; department: string; date: string;
      shiftStart: string; firstCallAt: string; minutesLate: number;
    };
    type GapRow = {
      key: string; member: string; department: string; date: string;
      gapCount: number; gaps: { start: string; end: string; minutes: number }[];
    };
    type MissedCallEntry = {
      key: string; pbxCallId: number | null; source: "pbx" | "quo"; date: string; missedAt: string;
      team: string; fromNumber: string; ringGroupName: string;
      availableAgents: string[]; busyAgents: string[];
    };

    const lateLogin: LateLoginRow[] = [];
    const availabilityGaps: GapRow[] = [];

    for (const date of dates) {
      const dayStart = laStartOfDay(date);
      for (const member of members) {
        const shiftNum = parseInt(member.shift || "0");
        if (!shiftNum) continue;
        // Shift N = N PM Egypt time. Egypt = UTC+2, PDT = UTC-7 → pdtHour = shiftNum + 3
        const pdtHour = shiftNum + 3;
        const shiftStartUtc = new Date(dayStart.getTime() + pdtHour * 3600 * 1000);
        if (shiftStartUtc > nowUtc) continue;

        const memberNames = agentNamesForMember(member.name);
        const allCalls: Date[] = [];
        for (const n of memberNames) {
          for (const t of callsByAgentDate.get(`${n.toLowerCase()}|${date}`) ?? []) allCalls.push(t);
        }
        allCalls.sort((a, b) => a.getTime() - b.getTime());

        // ── Late Login ──────────────────────────────────────────────
        const firstCall = allCalls.find((t) => t >= dayStart) ?? null;
        if (firstCall) {
          const minsLate = Math.round((firstCall.getTime() - shiftStartUtc.getTime()) / 60000);
          if (minsLate > 10) {
            lateLogin.push({
              key: `late:${member.name}:${date}`,
              member: member.name, department: member.department, date,
              shiftStart: shiftStartUtc.toISOString(), firstCallAt: firstCall.toISOString(), minutesLate: minsLate,
            });
          }
        }

        // ── Availability Gaps ───────────────────────────────────────
        const shiftDurHours = Math.max(1, parseInt(member.shiftHours || "8"));
        const shiftEndUtc = new Date(shiftStartUtc.getTime() + shiftDurHours * 3600 * 1000);
        const shiftCalls  = allCalls.filter((t) => t >= shiftStartUtc && t <= shiftEndUtc);
        if (shiftCalls.length >= 2) {
          const gaps: { start: string; end: string; minutes: number }[] = [];
          for (let i = 0; i < shiftCalls.length - 1; i++) {
            const gapMins = Math.round((shiftCalls[i + 1].getTime() - shiftCalls[i].getTime()) / 60000);
            if (gapMins > 5) gaps.push({ start: shiftCalls[i].toISOString(), end: shiftCalls[i + 1].toISOString(), minutes: gapMins });
          }
          if (gaps.length > 0) {
            availabilityGaps.push({
              key: `gap:${member.name}:${date}`,
              member: member.name, department: member.department, date,
              gapCount: gaps.length, gaps,
            });
          }
        }
      }
    }

    // ── Missed While Available ──────────────────────────────────────────────────
    const missedWhileAvail: MissedCallEntry[] = [];

    for (const missed of missedRows) {
      const missedMs   = new Date(missed.createdAt).getTime();
      const missedDate = new Date(missed.createdAt).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const dayStart   = laStartOfDay(missedDate);

      const availableAgents: string[] = [];
      const busyAgents:      string[] = [];

      const teamMembers = members.filter((m) => m.department.toLowerCase() === missed.team);
      for (const member of teamMembers) {
        const shiftNum = parseInt(member.shift || "0");
        if (!shiftNum) continue;
        // Shift N = N PM Egypt time. Egypt = UTC+2, PDT = UTC-7 → pdtHour = shiftNum + 3
        const shiftStart = dayStart.getTime() + (shiftNum + 3) * 3600 * 1000;
        const shiftDurH  = Math.max(1, parseInt(member.shiftHours || "8"));
        const shiftEnd   = shiftStart + shiftDurH * 3600 * 1000;
        if (missedMs < shiftStart || missedMs > shiftEnd) continue;

        const agentNames = agentNamesForMember(member.name);
        const busy = agentNames.some((n) => isAgentBusy(n.toLowerCase(), missedMs));
        (busy ? busyAgents : availableAgents).push(member.name);
      }

      if (availableAgents.length > 0) {
        missedWhileAvail.push({
          key: `missed:${missed.id}`,
          pbxCallId: missed.id, source: "pbx", date: missedDate,
          missedAt: missed.createdAt.toISOString(),
          team: missed.team, fromNumber: missed.fromNumber,
          ringGroupName: missed.ringGroupName,
          availableAgents, busyAgents,
        });
      }
    }

    // ── Missed While Available — OpenPhone (Quo) ────────────────────────────────
    for (const r of quoMissedRows) {
      // Ghost call filter: rang ≤2 seconds (fallback for old records without ring_duration_seconds)
      const ringDur = r.ringDurationSeconds;
      const isGhost = ringDur != null
        ? ringDur <= 2
        : (r.status === "no-answer" && (r.durationSeconds ?? 0) === 0) ||
          (r.status === "voicemail" && (r.durationSeconds ?? 0) === 0) ||
          (r.status === "voicemail-brief" && (r.durationSeconds ?? 0) <= 4);
      if (isGhost) continue;

      const missedMs   = new Date(r.createdAt).getTime();
      const missedDate = new Date(r.createdAt).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const dayStart   = laStartOfDay(missedDate);

      const availableAgents: string[] = [];
      const busyAgents:      string[] = [];

      const teamMembers = members.filter((m) => m.department.toLowerCase() === r.lineTeam);
      for (const member of teamMembers) {
        const shiftNum = parseInt(member.shift || "0");
        if (!shiftNum) continue;
        // Shift N = N PM Egypt time. Egypt = UTC+2, PDT = UTC-7 → pdtHour = shiftNum + 3
        const shiftStart = dayStart.getTime() + (shiftNum + 3) * 3600 * 1000;
        const shiftDurH  = Math.max(1, parseInt(member.shiftHours || "8"));
        const shiftEnd   = shiftStart + shiftDurH * 3600 * 1000;
        if (missedMs < shiftStart || missedMs > shiftEnd) continue;

        const agentNames = agentNamesForMember(member.name);
        const busy = agentNames.some((n) => isAgentBusy(n.toLowerCase(), missedMs));
        (busy ? busyAgents : availableAgents).push(member.name);
      }

      if (availableAgents.length > 0) {
        missedWhileAvail.push({
          key: `quo-missed:${r.id}`,
          pbxCallId: null, source: "quo", date: missedDate,
          missedAt: new Date(r.createdAt).toISOString(),
          team: r.lineTeam, fromNumber: r.participant,
          ringGroupName: r.lineName,
          availableAgents, busyAgents,
        });
      }
    }

    missedWhileAvail.sort((a, b) => b.missedAt.localeCompare(a.missedAt));

    return res.json({ lateLogin, availabilityGaps, missedWhileAvail, verifiedKeys: Array.from(verifiedKeys) });
  } catch (err) {
    req.log.error(err, "violations error");
    return res.status(500).json({ error: String(err) });
  }
});

/** POST /api/violations/verify — mark a violation verified (idempotent) */
router.post("/violations/verify", async (req, res) => {
  try {
    const { key, type, member, department, date, details, verifiedBy = "admin" } = req.body as {
      key: string; type: string; member: string; department: string;
      date: string; details: string; verifiedBy?: string;
    };
    if (!key || !type || !member || !date) return res.status(400).json({ error: "key, type, member, date required" });
    await db.insert(violationVerificationsTable)
      .values({ key, type, member, department, date, details: details ?? "{}", verifiedBy })
      .onConflictDoNothing();
    return res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "violations/verify POST error");
    return res.status(500).json({ error: String(err) });
  }
});

/** DELETE /api/violations/verify — unverify */
router.delete("/violations/verify", async (req, res) => {
  try {
    const { key } = req.body as { key: string };
    if (!key) return res.status(400).json({ error: "key required" });
    await db.delete(violationVerificationsTable).where(eq(violationVerificationsTable.key, key));
    return res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "violations/verify DELETE error");
    return res.status(500).json({ error: String(err) });
  }
});

/** GET /api/violations/verified — all persisted verified violations */
router.get("/violations/verified", async (req, res) => {
  try {
    const rows = await db.select().from(violationVerificationsTable)
      .orderBy(violationVerificationsTable.verifiedAt);
    return res.json({ items: rows });
  } catch (err) {
    req.log.error(err, "violations/verified GET error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
