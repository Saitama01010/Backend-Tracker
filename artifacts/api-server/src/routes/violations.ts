import { Router } from "express";
import {
  db, phoneCallsTable, attendanceMembersTable,
  violationVerificationsTable, pbxMissedCallsTable,
  agentBreaksTable,
} from "@workspace/db";
import { and, gte, lte, or, eq, inArray } from "drizzle-orm";
import { hydratePbxState, vosCallSpansCache, vosCallTimestampsCache } from "../modules/pbx/pbx.state.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  canAccessAttendanceDepartment,
  canAccessDateRange,
} from "../middleware/authorizationCore.js";
import {
  parseViolationVerificationPayload,
  validateOptionalWorkflowRange,
  violationVerificationKeyMatchesPayload,
} from "../lib/sensitiveWorkflowPolicy.js";
import {
  ATTENDANCE_MEMBER_ALIASES,
  addAttendanceCalendarDays,
  attendanceDate,
  attendanceStartOfDay,
} from "../lib/attendancePolicy.js";
import { attendanceShiftStart } from "../lib/businessTime.js";
import { OPERATIONAL_CONFIG } from "../lib/operationalConfig.js";
import {
  canAccessMetricAgent,
  loadAuthorizationAgentDirectory,
  type AuthorizationAgentDirectory,
} from "../lib/authorizationScope.js";

const TEAM_QUO_LINES = [...OPERATIONAL_CONFIG.trackedTeamLines];

const router = Router();
router.use("/violations", requireAuth);

function laStartOfDay(dateStr: string): Date {
  return attendanceStartOfDay(dateStr);
}

function dateRangeLA(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let current = from; current <= to; current = addAttendanceCalendarDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

const MEMBER_TO_AGENT_NAMES = ATTENDANCE_MEMBER_ALIASES;

function agentNamesForMember(name: string): readonly string[] {
  return MEMBER_TO_AGENT_NAMES[name] ?? [name];
}

function canAccessViolationIdentity(
  user: NonNullable<Express.Request["user"]>,
  member: string,
  department: string,
  directory: AuthorizationAgentDirectory,
): boolean {
  return canAccessAttendanceDepartment(user, department)
    && [member, ...agentNamesForMember(member)]
      .some((name) => canAccessMetricAgent(user, name, directory));
}

async function resolveMissedVerificationScope(key: string): Promise<{ department: string; date: string } | null> {
  const pbxMatch = /^missed:(\d+)$/.exec(key);
  if (pbxMatch) {
    const id = Number(pbxMatch[1]);
    if (!Number.isSafeInteger(id)) return null;
    const [row] = await db.select({
      team: pbxMissedCallsTable.team,
      createdAt: pbxMissedCallsTable.createdAt,
    }).from(pbxMissedCallsTable).where(eq(pbxMissedCallsTable.id, id)).limit(1);
    if (!row || !["retention", "cs", "nsf"].includes(row.team)) return null;
    return {
      department: row.team,
      date: new Date(row.createdAt).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
    };
  }

  const quoMatch = /^quo-missed:([A-Za-z0-9._:-]{1,200})$/.exec(key);
  if (!quoMatch) return null;
  const [row] = await db.select({
    direction: phoneCallsTable.direction,
    status: phoneCallsTable.status,
    lineTeam: phoneCallsTable.lineTeam,
    lineName: phoneCallsTable.lineName,
    createdAt: phoneCallsTable.createdAt,
  }).from(phoneCallsTable).where(eq(phoneCallsTable.id, quoMatch[1]!)).limit(1);
  if (!row
    || row.direction !== "incoming"
    || !["no-answer", "voicemail", "missed", "voicemail-brief"].includes(row.status)
    || !TEAM_QUO_LINES.includes(row.lineName)
    || !["retention", "cs", "nsf"].includes(row.lineTeam)) return null;
  return {
    department: row.lineTeam,
    date: new Date(row.createdAt).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
  };
}

/** GET /api/violations?from=YYYY-MM-DD&to=YYYY-MM-DD */
router.get("/violations", async (req, res) => {
  try {
    await hydratePbxState();
    const todayLA = attendanceDate();
    const from = (req.query["from"] as string) || addAttendanceCalendarDays(todayLA, -7);
    const to   = (req.query["to"]   as string) || todayLA;
    const requestedRange = validateOptionalWorkflowRange(from, to);
    if (!requestedRange.ok) return res.status(400).json({ error: requestedRange.error });

    const dates = dateRangeLA(from, to).filter((d) => d <= todayLA);
    if (dates.length === 0) {
      return res.json({ lateLogin: [], availabilityGaps: [], missedWhileAvail: [], verifiedKeys: [] });
    }

    const rangeStart = laStartOfDay(dates[0]);
    const rangeEnd = new Date(laStartOfDay(addAttendanceCalendarDays(dates[dates.length - 1]!, 1)).getTime() - 1);

    // Parallel fetch: members, verified keys, phone calls, missed PBX calls, missed Quo calls
    const [members, verifications, callRows, missedRows, quoMissedRows, directory] = await Promise.all([
      db.select().from(attendanceMembersTable).where(eq(attendanceMembersTable.active, true)),
      db.select().from(violationVerificationsTable),
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
      loadAuthorizationAgentDirectory(),
    ]);

    const scopedMembers = members.filter((member) => canAccessViolationIdentity(
      req.user!,
      member.name,
      member.department,
      directory,
    ));
    const scopedVerifications = verifications.filter((verification) => canAccessViolationIdentity(
      req.user!,
      verification.member,
      verification.department,
      directory,
    ));
    const verifiedKeys = new Set(scopedVerifications.map((v) => v.key));

    const allAgentLower = new Set<string>();
    for (const m of scopedMembers) {
      for (const n of agentNamesForMember(m.name)) allAgentLower.add(n.toLowerCase());
    }

    // ── Build per-agent call maps ─────────────────────────────────────────────
    // callsByAgentDate: for first-call and gap detection
    type AgentCallEvent = { at: Date; source: "quo" | "pbx"; id: string };
    const callsByAgentDate = new Map<string, AgentCallEvent[]>();
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
      dateArr.push({ at: t, source: "quo", id: `quo:${lower}:${t.toISOString()}` });
      callsByAgentDate.set(dateKey, dateArr);

      // spans map for busy check
      // in-progress calls have duration=0 — use a generous 3-hour fallback.
      // OpenPhone leaves warm-transfer/coaching call legs as "in-progress" long
      // after they end (sometimes indefinitely). A short fallback caused agents
      // who were genuinely on a long call to be wrongly flagged "available" for
      // missed calls landing >30 min after the call began. 3 h covers realistic
      // long retention/coaching calls without obscuring real availability the
      // following shift.
      const INPROGRESS_FALLBACK_S = 3 * 3600;
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
    for (const [agentLower, events] of vosCallTimestampsCache.entries()) {
      if (!allAgentLower.has(agentLower)) continue;
      for (const ev of events) {
        const t = new Date(ev.at);
        if (t < rangeStart || t > rangeEnd) continue;
        const dateLA = t.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
        const dateKey = `${agentLower}|${dateLA}`;
        const dateArr = callsByAgentDate.get(dateKey) ?? [];
        dateArr.push({ at: t, source: "pbx", id: ev.id });
        callsByAgentDate.set(dateKey, dateArr);
      }
    }
    for (const [key, arr] of callsByAgentDate) {
      const seen = new Set<string>();
      const deduped: AgentCallEvent[] = [];
      for (const ev of arr.sort((a, b) => a.at.getTime() - b.at.getTime())) {
        const bucket = Math.floor(ev.at.getTime() / 1000);
        const dedupeKey = String(bucket);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        deduped.push(ev);
      }
      callsByAgentDate.set(key, deduped);
    }

    function isAgentBusy(agentLower: string, atMs: number): boolean {
      // Check OpenPhone (phone_calls DB) spans first
      if ((agentCallSpans.get(agentLower) ?? []).some((s) => s.start <= atMs && s.end >= atMs)) return true;
      // Also check VoSLogic dialer spans (in-memory cache from last VoS refresh)
      if ((vosCallSpansCache.get(agentLower) ?? []).some((s) => s.start <= atMs && s.end >= atMs)) return true;
      return false;
    }

    const nowUtc = new Date();

    type LateLoginRow = {
      key: string; member: string; department: string; date: string;
      shiftStart: string; firstCallAt: string; minutesLate: number;
    };
    type GapRow = {
      key: string; member: string; department: string; date: string;
      gapCount: number; gaps: { start: string; end: string; minutes: number; source: "quo" | "pbx" | "combined" }[];
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
      for (const member of scopedMembers) {
        const shiftNum = parseInt(member.shift || "0");
        if (!shiftNum) continue;
        const shiftStartUtc = attendanceShiftStart(date, shiftNum);
        if (!shiftStartUtc) continue;
        if (shiftStartUtc > nowUtc) continue;

        const memberNames = agentNamesForMember(member.name);
        const allCalls: AgentCallEvent[] = [];
        for (const n of memberNames) {
          for (const t of callsByAgentDate.get(`${n.toLowerCase()}|${date}`) ?? []) allCalls.push(t);
        }
        allCalls.sort((a, b) => a.at.getTime() - b.at.getTime());

        // ── Late Login ──────────────────────────────────────────────
        const firstCall = allCalls.find((t) => t.at >= dayStart) ?? null;
        if (firstCall) {
          const minsLate = Math.round((firstCall.at.getTime() - shiftStartUtc.getTime()) / 60000);
          if (minsLate > 10) {
            lateLogin.push({
              key: `late:${member.name}:${date}`,
              member: member.name, department: member.department, date,
              shiftStart: shiftStartUtc.toISOString(), firstCallAt: firstCall.at.toISOString(), minutesLate: minsLate,
            });
          }
        }

        // ── Availability Gaps ───────────────────────────────────────
        const shiftDurHours = Math.max(1, parseInt(member.shiftHours || "8"));
        const shiftEndUtc = new Date(shiftStartUtc.getTime() + shiftDurHours * 3600 * 1000);
        const shiftCalls  = allCalls.filter((t) => t.at >= shiftStartUtc && t.at <= shiftEndUtc);
        if (shiftCalls.length >= 2) {
          const gaps: { start: string; end: string; minutes: number; source: "quo" | "pbx" | "combined" }[] = [];
          for (let i = 0; i < shiftCalls.length - 1; i++) {
            const prev = shiftCalls[i];
            const next = shiftCalls[i + 1];
            const gapMins = Math.round((next.at.getTime() - prev.at.getTime()) / 60000);
            const source = prev.source === next.source ? prev.source : "combined";
            if (gapMins > 5) gaps.push({ start: prev.at.toISOString(), end: next.at.toISOString(), minutes: gapMins, source });
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
    // Suppress very-recent misses: give OpenPhone / VoSLogic 2 h to finish
    // recording the calls of all teammates before deciding who was "available".
    // Without this, a teammate still on a long call may be wrongly flagged as
    // available because their call hasn't been synced (or hasn't ended) yet.
    const MISSED_GRACE_MS = 2 * 3600 * 1000;
    const missedCutoffMs  = nowUtc.getTime() - MISSED_GRACE_MS;

    const missedWhileAvail: MissedCallEntry[] = [];

    for (const missed of missedRows) {
      const missedMs   = new Date(missed.createdAt).getTime();
      if (missedMs > missedCutoffMs) continue;
      const missedDate = new Date(missed.createdAt).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const availableAgents: string[] = [];
      const busyAgents:      string[] = [];

      const teamMembers = scopedMembers.filter((m) => m.department.toLowerCase() === missed.team);
      for (const member of teamMembers) {
        const shiftNum = parseInt(member.shift || "0");
        if (!shiftNum) continue;
        const shiftStartDate = attendanceShiftStart(missedDate, shiftNum);
        if (!shiftStartDate) continue;
        const shiftStart = shiftStartDate.getTime();
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
      if (missedMs > missedCutoffMs) continue;
      const missedDate = new Date(r.createdAt).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const availableAgents: string[] = [];
      const busyAgents:      string[] = [];

      const teamMembers = scopedMembers.filter((m) => m.department.toLowerCase() === r.lineTeam);
      for (const member of teamMembers) {
        const shiftNum = parseInt(member.shift || "0");
        if (!shiftNum) continue;
        const shiftStartDate = attendanceShiftStart(missedDate, shiftNum);
        if (!shiftStartDate) continue;
        const shiftStart = shiftStartDate.getTime();
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
    return res.status(500).json({ error: "Unable to load violations." });
  }
});

/** POST /api/violations/verify — mark a violation verified (idempotent) */
router.post("/violations/verify", async (req, res) => {
  try {
    const payload = parseViolationVerificationPayload(req.body, req.user!.username);
    if (!payload) return res.status(400).json({ error: "Invalid violation verification." });
    if (!violationVerificationKeyMatchesPayload(payload, agentNamesForMember(payload.member))) {
      return res.status(400).json({ error: "Invalid violation verification." });
    }
    const missedScope = payload.type === "missed_call"
      ? await resolveMissedVerificationScope(payload.key)
      : null;
    if (payload.type === "missed_call" && (!missedScope
      || missedScope.department !== payload.department.toLowerCase()
      || missedScope.date !== payload.date)) {
      return res.status(400).json({ error: "Invalid violation verification." });
    }
    const authorizedDepartment = missedScope?.department ?? payload.department;
    const authorizedDate = missedScope?.date ?? payload.date;
    if (!canAccessDateRange(req.user!, [authorizedDate])) return res.status(403).json({ error: "Forbidden" });
    const directory = await loadAuthorizationAgentDirectory();
    if (!canAccessViolationIdentity(req.user!, payload.member, authorizedDepartment, directory)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await db.insert(violationVerificationsTable)
      .values({ ...payload, verifiedBy: req.user!.username })
      .onConflictDoNothing();
    return res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "violations/verify POST error");
    return res.status(500).json({ error: "Unable to verify violation." });
  }
});

/** DELETE /api/violations/verify — unverify */
router.delete("/violations/verify", requireRole("admin"), async (req, res) => {
  try {
    const { key } = req.body as { key: string };
    if (typeof key !== "string" || !key.trim() || key.length > 512) {
      return res.status(400).json({ error: "key required" });
    }
    await db.delete(violationVerificationsTable).where(eq(violationVerificationsTable.key, key));
    return res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "violations/verify DELETE error");
    return res.status(500).json({ error: "Unable to remove violation verification." });
  }
});

/** GET /api/violations/verified — all persisted verified violations */
router.get("/violations/verified", async (req, res) => {
  try {
    const rows = await db.select().from(violationVerificationsTable)
      .orderBy(violationVerificationsTable.verifiedAt);
    const directory = await loadAuthorizationAgentDirectory();
    const items = rows.filter((row) => canAccessViolationIdentity(req.user!, row.member, row.department, directory));
    return res.json({ items });
  } catch (err) {
    req.log.error(err, "violations/verified GET error");
    return res.status(500).json({ error: "Unable to load verified violations." });
  }
});

export default router;
