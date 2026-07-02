import { Router, type IRouter } from "express";
import ExcelJS from "exceljs";
import { db, phoneCallsTable, onboardingClassificationsTable } from "@workspace/db";
import { and, eq, gte, lte, ne } from "drizzle-orm";
import { canonicalAgentName } from "./quoSync.js";
import { getBlockedNumbers } from "../lib/blockedNumbers.js";

const router: IRouter = Router();

// ─── Onboarding line ──────────────────────────────────────────────────────────
const LINE_ID = "PNdcJ0UEu5";
const LINE_LABEL = "(949) 315-7441";
const CASSIE = "Cassie Lynn";

// Gaps between consecutive calls longer than this (seconds) are treated as
// off-shift / breaks, not "available between calls", so lunch and overnight gaps
// don't inflate the idle metric.
const MAX_GAP_SEC = 60 * 60;
// Agents need at least this many inbound calls to be ranked by response rate, so
// a single answered/missed call can't put someone at the top or bottom.
const MIN_RANK_INBOUND = 10;

const TZ = "America/Los_Angeles";

/** YYYY-MM-DD in California time. */
function caDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Hour of day (0-23) in California time. */
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, hour: "2-digit" });
function caHour(d: Date): number {
  const part = hourFmt.formatToParts(d).find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(part, 10) % 24;
}

/** Midnight (California) for a YYYY-MM-DD string → UTC bounds for that CA day. */
function caDateBounds(dateStr: string): { from: Date; to: Date } {
  const pdtMidnight = new Date(`${dateStr}T07:00:00Z`);
  const fromMs =
    caDate(pdtMidnight) === dateStr ? pdtMidnight.getTime() : pdtMidnight.getTime() + 60 * 60 * 1000;
  return { from: new Date(fromMs), to: new Date(fromMs + 24 * 60 * 60 * 1000) };
}

function parseRange(from?: string, to?: string): { fromDate: Date; toDate: Date } {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const fromDate = !from
    ? new Date("2000-01-01T00:00:00Z")
    : DATE_RE.test(from)
      ? caDateBounds(from).from
      : new Date(from);
  const toDate = !to ? new Date() : DATE_RE.test(to) ? caDateBounds(to).to : new Date(to);
  return { fromDate, toDate };
}

/** Re-derive answered/voicemail/missed using the same rules as /api/quo/stats. */
function effectiveStatus(status: string, direction: string, postAnswer: number | null, dur: number): string {
  if (status === "completed" && direction === "outgoing") {
    if (postAnswer !== null && postAnswer !== undefined) {
      if (postAnswer >= 60) return "completed";
      if (postAnswer >= 20) return "voicemail";
      return "voicemail-brief";
    }
    if (dur >= 75) return "completed";
    if (dur >= 35) return "voicemail";
    return "voicemail-brief";
  }
  return status;
}

interface AgentAgg {
  name: string;
  totalCalls: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  inboundReceived: number;
  inboundAnswered: number;
  inboundMissed: number;
  talkSeconds: number;
  uniqueContacts: Set<string>;
  onboarded: number;
  connection: number;
  taxMentions: number;
  firstRingAttempts: number;
  firstRingAnswered: number;
  firstRingDetails: FirstRingDetail[];
  gaps: number[];
  calls: { createdAt: Date; dur: number }[];
}

function newAgent(name: string): AgentAgg {
  return {
    name,
    totalCalls: 0,
    inbound: 0,
    outbound: 0,
    answered: 0,
    missed: 0,
    voicemail: 0,
    inboundReceived: 0,
    inboundAnswered: 0,
    inboundMissed: 0,
    talkSeconds: 0,
    uniqueContacts: new Set(),
    onboarded: 0,
    connection: 0,
    taxMentions: 0,
    firstRingAttempts: 0,
    firstRingAnswered: 0,
    firstRingDetails: [],
    gaps: [],
    calls: [],
  };
}

interface FirstRingDetail {
  customerNumber: string;
  normalizedNumber: string;
  firstInboundAt: string;
  answered: boolean;
  status: string;
  agent: string;
  line: string;
  source: "OpenPhone/QUO";
}

interface CallRow {
  id: string;
  agentName: string | null;
  participant: string;
  lineName: string;
  direction: string;
  status: string;
  durationSeconds: number;
  postAnswerSeconds: number | null;
  createdAt: Date;
  callType: string | null;
  mentionsTax: boolean | null;
}

interface Hourly {
  hour: number;
  calls: number;
  inbound: number;
  missed: number;
  idleSeconds: number;
  gapCount: number;
}

// Hours need at least this many measured gaps before their average idle time is
// trusted as "availability", so one long overnight gap can't win the peak.
const MIN_GAP_COUNT = 5;

interface Analytics {
  meta: {
    line: string;
    from: string | null;
    to: string | null;
    generatedAt: string;
    dataFirst: string | null;
    dataLast: string | null;
    totalAgents: number;
  };
  kpis: {
    totalCalls: number;
    inbound: number;
    outbound: number;
    answered: number;
    missed: number;
    voicemail: number;
    talkSeconds: number;
    inboundReceived: number;
    inboundAnswered: number;
    inboundMissed: number;
    responseRate: number; // 0-100
    missedRatio: number; // 0-100
    avgTalkSec: number;
    avgGapMin: number;
    firstRingAttempts: number;
    firstRingAnswered: number;
    firstRingMissed: number;
    firstRingResponseRate: number;
  };
  agents: {
    name: string;
    totalCalls: number;
    inbound: number;
    outbound: number;
    answered: number;
    missed: number;
    voicemail: number;
    talkSeconds: number;
    uniqueContacts: number;
    responseRate: number;
    missedRatio: number;
    avgGapMin: number;
    onboarded: number;
    connection: number;
    onboardedRate: number;
    taxMentions: number;
    firstRingAttempts: number;
    firstRingAnswered: number;
    firstRingMissed: number;
    firstRingResponseRate: number;
    firstRingDetails: FirstRingDetail[];
    vsTeam: { responseRate: number; onboardedRate: number; avgGapMin: number };
    ranked: boolean;
    overflow: boolean;
  }[];
  hourly: { hour: number; calls: number; inbound: number; missed: number; idleMinutes: number }[];
  peaks: { mostMissedHour: number | null; mostAvailableHour: number | null; busiestHour: number | null };
  cassie: {
    found: boolean;
    name: string;
    totalCalls: number;
    inbound: number;
    answered: number;
    responseRate: number;
    missedRatio: number;
    talkSeconds: number;
    avgGapMin: number;
    uniqueContacts: number;
    onboarded: number;
    connection: number;
    onboardedRate: number;
    taxMentions: number;
    vsTeam: { responseRate: number; onboardedRate: number; avgGapMin: number };
  } | null;
  insights: string[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function rate(num: number, den: number): number {
  return den > 0 ? round1((num / den) * 100) : 0;
}
function normalizePhoneForGrouping(value: string): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function computeAnalytics(from?: string, to?: string): Promise<Analytics> {
  const { fromDate, toDate } = parseRange(from, to);

  const rows = (await db
    .select({
      id: phoneCallsTable.id,
      agentName: phoneCallsTable.agentName,
      participant: phoneCallsTable.participant,
      lineName: phoneCallsTable.lineName,
      direction: phoneCallsTable.direction,
      status: phoneCallsTable.status,
      durationSeconds: phoneCallsTable.durationSeconds,
      postAnswerSeconds: phoneCallsTable.postAnswerSeconds,
      createdAt: phoneCallsTable.createdAt,
      callType: onboardingClassificationsTable.callType,
      mentionsTax: onboardingClassificationsTable.mentionsTax,
    })
    .from(phoneCallsTable)
    .leftJoin(onboardingClassificationsTable, eq(onboardingClassificationsTable.callId, phoneCallsTable.id))
    .where(
      and(
        eq(phoneCallsTable.lineId, LINE_ID),
        gte(phoneCallsTable.createdAt, fromDate),
        lte(phoneCallsTable.createdAt, toDate),
        ne(phoneCallsTable.status, "in-progress"),
      ),
    )
    .orderBy(phoneCallsTable.createdAt)) as CallRow[];

  const blocklist = await getBlockedNumbers();

  const agents = new Map<string, AgentAgg>();
  const hourly: Hourly[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    calls: 0,
    inbound: 0,
    missed: 0,
    idleSeconds: 0,
    gapCount: 0,
  }));

  let dataFirst: Date | null = null;
  let dataLast: Date | null = null;
  const teamFirstRing = new Map<string, FirstRingDetail>();

  for (const row of rows) {
    if (row.participant && blocklist.has(row.participant)) continue;
    const name = canonicalAgentName(row.agentName) ?? "Unknown";
    let a = agents.get(name);
    if (!a) {
      a = newAgent(name);
      agents.set(name, a);
    }
    const dur = row.durationSeconds ?? 0;
    const eff = effectiveStatus(row.status, row.direction, row.postAnswerSeconds, dur);
    const inbound = row.direction === "incoming";
    const hour = caHour(row.createdAt);

    a.totalCalls++;
    a.talkSeconds += dur;
    if (row.participant) a.uniqueContacts.add(row.participant);
    a.calls.push({ createdAt: row.createdAt, dur });
    if (inbound) a.inbound++;
    else a.outbound++;

    if (eff === "completed") a.answered++;
    else if (eff === "voicemail" || eff === "voicemail-brief") a.voicemail++;
    else a.missed++;

    // Inbound responsiveness — the heart of "response rate" / "missed ratio".
    if (inbound) {
      a.inboundReceived++;
      if (row.status === "completed") a.inboundAnswered++;
      else a.inboundMissed++;

      const normalizedNumber = normalizePhoneForGrouping(row.participant);
      if (normalizedNumber) {
        const answeredFirstAttempt = row.status === "completed";
        const detail: FirstRingDetail = {
          customerNumber: row.participant,
          normalizedNumber,
          firstInboundAt: row.createdAt.toISOString(),
          answered: answeredFirstAttempt,
          status: row.status,
          agent: name,
          line: row.lineName || LINE_LABEL,
          source: "OpenPhone/QUO",
        };
        if (!teamFirstRing.has(normalizedNumber)) teamFirstRing.set(normalizedNumber, detail);
        if (!a.firstRingDetails.some((d) => d.normalizedNumber === normalizedNumber)) {
          a.firstRingAttempts++;
          if (answeredFirstAttempt) a.firstRingAnswered++;
          a.firstRingDetails.push(detail);
        }
      }
    }

    if (row.callType === "onboarded") a.onboarded++;
    else if (row.callType === "connection") a.connection++;
    if (row.mentionsTax === true) a.taxMentions++;

    hourly[hour]!.calls++;
    if (inbound) {
      hourly[hour]!.inbound++;
      if (row.status !== "completed") hourly[hour]!.missed++;
    }

    if (!dataFirst || row.createdAt < dataFirst) dataFirst = row.createdAt;
    if (!dataLast || row.createdAt > dataLast) dataLast = row.createdAt;
  }

  // On this shared ring-group line, missed inbound calls are attributed by
  // OpenPhone to the line-owner account rather than to whoever let it ring.
  // An "overflow" account answers nothing and dials nothing — it is purely the
  // bucket where unanswered inbound calls land. It is NOT a working agent, so it
  // is excluded from the response-rate ranking and from availability math (its
  // "gaps" are gaps between missed calls, not real idle time).
  const isOverflow = (a: AgentAgg) => a.answered === 0 && a.outbound === 0 && a.inboundMissed > 0;

  // Availability: gaps between consecutive calls per agent within the same CA day.
  const allGaps: number[] = [];
  for (const a of agents.values()) {
    if (isOverflow(a)) continue;
    a.calls.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    for (let i = 0; i < a.calls.length - 1; i++) {
      const cur = a.calls[i]!;
      const next = a.calls[i + 1]!;
      const endMs = cur.createdAt.getTime() + cur.dur * 1000;
      const gapSec = (next.createdAt.getTime() - endMs) / 1000;
      if (gapSec <= 0 || gapSec > MAX_GAP_SEC) continue;
      if (caDate(cur.createdAt) !== caDate(next.createdAt)) continue;
      a.gaps.push(gapSec);
      allGaps.push(gapSec);
      const bucket = hourly[caHour(new Date(endMs))]!;
      bucket.idleSeconds += gapSec;
      bucket.gapCount++;
    }
  }

  // Team KPIs
  let totalCalls = 0,
    inbound = 0,
    outbound = 0,
    answered = 0,
    missed = 0,
    voicemail = 0,
    talkSeconds = 0,
    inboundReceived = 0,
    inboundAnswered = 0,
    inboundMissed = 0;
  for (const a of agents.values()) {
    totalCalls += a.totalCalls;
    inbound += a.inbound;
    outbound += a.outbound;
    answered += a.answered;
    missed += a.missed;
    voicemail += a.voicemail;
    talkSeconds += a.talkSeconds;
    inboundReceived += a.inboundReceived;
    inboundAnswered += a.inboundAnswered;
    inboundMissed += a.inboundMissed;
  }
  const teamAvgGapMin = allGaps.length ? round1(allGaps.reduce((s, g) => s + g, 0) / allGaps.length / 60) : 0;
  const teamResponseRate = rate(inboundAnswered, inboundReceived);
  const firstRingAttempts = teamFirstRing.size;
  const firstRingAnswered = [...teamFirstRing.values()].filter((d) => d.answered).length;
  const firstRingMissed = firstRingAttempts - firstRingAnswered;
  const firstRingResponseRate = rate(firstRingAnswered, firstRingAttempts);

  // Team onboarded-rate (for spotlight comparisons)
  let teamOnboarded = 0,
    teamClosed = 0;
  for (const a of agents.values()) {
    teamOnboarded += a.onboarded;
    teamClosed += a.onboarded + a.connection;
  }
  const teamOnboardedRate = rate(teamOnboarded, teamClosed);

  const agentList = [...agents.values()]
    .map((a) => {
      const avgGapMin = a.gaps.length ? round1(a.gaps.reduce((s, g) => s + g, 0) / a.gaps.length / 60) : 0;
      const closed = a.onboarded + a.connection;
      return {
        name: a.name,
        totalCalls: a.totalCalls,
        inbound: a.inbound,
        outbound: a.outbound,
        answered: a.answered,
        missed: a.missed,
        voicemail: a.voicemail,
        talkSeconds: a.talkSeconds,
        uniqueContacts: a.uniqueContacts.size,
        responseRate: rate(a.inboundAnswered, a.inboundReceived),
        missedRatio: rate(a.inboundMissed, a.inboundReceived),
        avgGapMin,
        onboarded: a.onboarded,
        connection: a.connection,
        onboardedRate: rate(a.onboarded, closed),
        taxMentions: a.taxMentions,
        firstRingAttempts: a.firstRingAttempts,
        firstRingAnswered: a.firstRingAnswered,
        firstRingMissed: a.firstRingAttempts - a.firstRingAnswered,
        firstRingResponseRate: rate(a.firstRingAnswered, a.firstRingAttempts),
        firstRingDetails: a.firstRingDetails,
        vsTeam: {
          responseRate: round1(rate(a.inboundAnswered, a.inboundReceived) - teamResponseRate),
          onboardedRate: round1(rate(a.onboarded, closed) - teamOnboardedRate),
          avgGapMin: round1(avgGapMin - teamAvgGapMin),
        },
        ranked: !isOverflow(a) && a.inboundReceived >= MIN_RANK_INBOUND,
        overflow: isOverflow(a),
      };
    })
    .sort((x, y) => {
      // Overflow (missed-call sink) accounts always sort last, then unranked
      // (too-few-calls) agents. On this ring-group line per-agent response rate
      // is degenerate (~100% for everyone who answers), so rank the real agents
      // by workload (answered volume) first, then by onboarding conversion as
      // the tie-break — matching the "responsive & productive" framing in the UI.
      if (x.overflow !== y.overflow) return x.overflow ? 1 : -1;
      if (x.ranked !== y.ranked) return x.ranked ? -1 : 1;
      if (y.answered !== x.answered) return y.answered - x.answered;
      if (y.onboardedRate !== x.onboardedRate) return y.onboardedRate - x.onboardedRate;
      return y.responseRate - x.responseRate;
    });

  // Peaks
  const argmax = (sel: (h: Hourly) => number): number | null => {
    let best: number | null = null;
    let bestVal = 0;
    for (const h of hourly) {
      const v = sel(h);
      if (v > bestVal) {
        bestVal = v;
        best = h.hour;
      }
    }
    return best;
  };
  // "Availability" = average idle minutes between calls in an hour, NOT total
  // idle seconds (total is biased toward busy hours, which simply have more
  // gaps). Hours with too few measured gaps are ignored so a lone overnight gap
  // can't win. avgIdleSec returns 0 for those, keeping them out of the argmax.
  const avgIdleSec = (h: Hourly) => (h.gapCount >= MIN_GAP_COUNT ? h.idleSeconds / h.gapCount : 0);
  const peaks = {
    mostMissedHour: argmax((h) => h.missed),
    mostAvailableHour: argmax(avgIdleSec),
    busiestHour: argmax((h) => h.calls),
  };

  // Cassie spotlight
  const c = agents.get(CASSIE) ?? null;
  let cassie: Analytics["cassie"] = null;
  if (c) {
    const avgGapMin = c.gaps.length ? round1(c.gaps.reduce((s, g) => s + g, 0) / c.gaps.length / 60) : 0;
    const closed = c.onboarded + c.connection;
    cassie = {
      found: true,
      name: c.name,
      totalCalls: c.totalCalls,
      inbound: c.inbound,
      answered: c.answered,
      responseRate: rate(c.inboundAnswered, c.inboundReceived),
      missedRatio: rate(c.inboundMissed, c.inboundReceived),
      talkSeconds: c.talkSeconds,
      avgGapMin,
      uniqueContacts: c.uniqueContacts.size,
      onboarded: c.onboarded,
      connection: c.connection,
      onboardedRate: rate(c.onboarded, closed),
      taxMentions: c.taxMentions,
      vsTeam: {
        responseRate: round1(rate(c.inboundAnswered, c.inboundReceived) - teamResponseRate),
        onboardedRate: round1(rate(c.onboarded, closed) - teamOnboardedRate),
        avgGapMin: round1(avgGapMin - teamAvgGapMin),
      },
    };
  }

  // Insights (deterministic, from the numbers above)
  const insights: string[] = [];
  const fmtHr = (h: number | null) => (h === null ? "—" : `${String(h).padStart(2, "0")}:00`);
  insights.push(
    `The team answered ${teamResponseRate}% of ${inboundReceived.toLocaleString()} inbound calls; ${rate(inboundMissed, inboundReceived)}% (${inboundMissed.toLocaleString()}) were missed.`,
  );
  if (peaks.mostMissedHour !== null) {
    const mh = hourly[peaks.mostMissedHour]!;
    insights.push(
      `Missed calls peak around ${fmtHr(peaks.mostMissedHour)} (${mh.missed} missed of ${mh.inbound} inbound). Adding coverage in this hour would recover the most calls.`,
    );
  }
  if (peaks.busiestHour !== null) {
    insights.push(`Busiest hour is ${fmtHr(peaks.busiestHour)} (${hourly[peaks.busiestHour]!.calls} calls).`);
  }
  if (peaks.mostAvailableHour !== null) {
    insights.push(
      `Most available window (longest average idle between calls) is around ${fmtHr(peaks.mostAvailableHour)} — a good time for outbound follow-ups or coaching. Across all working hours the team averages ${teamAvgGapMin} min idle between calls.`,
    );
  }
  // This is a shared ring-group line: inbound calls ring every agent, and a
  // missed call can't be pinned on one person, so per-agent response rate is
  // ~100% for everyone who picks up. Rank by who carries the most volume and
  // converts best instead of by a degenerate per-agent response rate.
  const ranked = agentList.filter((a) => a.ranked);
  if (ranked.length >= 2) {
    const byVolume = [...ranked].sort((a, b) => b.answered - a.answered);
    const top = byVolume[0]!;
    const byConv = [...ranked].sort((a, b) => b.onboardedRate - a.onboardedRate);
    const bestConv = byConv[0]!;
    insights.push(
      `Calls ring the whole team, so missed calls aren't attributable to one agent — per-agent response rate stays ~100% for everyone who answers. Rank by workload instead: ${top.name} carries the most, answering ${top.answered.toLocaleString()} calls. Best onboarding conversion: ${bestConv.name} at ${bestConv.onboardedRate}%.`,
    );
  }
  const overflow = agentList.find((a) => a.overflow);
  if (overflow && overflow.inbound > 0) {
    insights.push(
      `${overflow.inbound.toLocaleString()} inbound calls went unanswered by any agent (they land on the line's overflow account "${overflow.name}"). These are the calls worth recovering — concentrate coverage on the ${fmtHr(peaks.mostMissedHour)} peak.`,
    );
  }
  if (teamResponseRate < 80 && inboundReceived > 50) {
    insights.push(`Response rate is below 80% — staffing or a callback workflow is the biggest improvement lever.`);
  }
  if (cassie) {
    const better = cassie.vsTeam.onboardedRate >= 0;
    insights.push(
      `Cassie converts ${cassie.onboardedRate}% of her connected calls into onboarded customers (${better ? "+" : ""}${cassie.vsTeam.onboardedRate} pts vs team), answering ${cassie.responseRate}% of inbound.`,
    );
  }

  return {
    meta: {
      line: LINE_LABEL,
      from: from ?? null,
      to: to ?? null,
      generatedAt: new Date().toISOString(),
      dataFirst: dataFirst ? dataFirst.toISOString() : null,
      dataLast: dataLast ? dataLast.toISOString() : null,
      totalAgents: agents.size,
    },
    kpis: {
      totalCalls,
      inbound,
      outbound,
      answered,
      missed,
      voicemail,
      talkSeconds,
      inboundReceived,
      inboundAnswered,
      inboundMissed,
      responseRate: teamResponseRate,
      missedRatio: rate(inboundMissed, inboundReceived),
      avgTalkSec: answered > 0 ? Math.round(talkSeconds / answered) : 0,
      avgGapMin: teamAvgGapMin,
      firstRingAttempts,
      firstRingAnswered,
      firstRingMissed,
      firstRingResponseRate,
    },
    agents: agentList,
    hourly: hourly.map((h) => ({
      hour: h.hour,
      calls: h.calls,
      inbound: h.inbound,
      missed: h.missed,
      // Average idle minutes between calls in this hour (not total — total is
      // biased toward busy hours). 0 when too few gaps to be meaningful.
      idleMinutes: h.gapCount >= MIN_GAP_COUNT ? round1(h.idleSeconds / h.gapCount / 60) : 0,
    })),
    peaks,
    cassie,
    insights,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/ob-analytics?from=&to=  → computed onboarding-team analytics
router.get("/ob-analytics", async (req, res) => {
  try {
    const from = req.query["from"] as string | undefined;
    const to = req.query["to"] as string | undefined;
    const data = await computeAnalytics(from, to);
    res.json(data);
  } catch (err) {
    req.log.error(err, "ob-analytics error");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/ob-analytics/download?from=&to=  → Excel workbook of the analysis
router.get("/ob-analytics/download", async (req, res) => {
  try {
    const from = req.query["from"] as string | undefined;
    const to = req.query["to"] as string | undefined;
    const data = await computeAnalytics(from, to);
    const wb = await buildAnalyticsWorkbook(data);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Onboarding_Team_Analysis.xlsx"`);
    res.end(Buffer.from(buf));
  } catch (err) {
    req.log.error(err, "ob-analytics download error");
    res.status(500).json({ error: String(err) });
  }
});

// ─── Workbook ─────────────────────────────────────────────────────────────────
function thinBorder(): Partial<ExcelJS.Borders> {
  const side = { style: "thin" as const, color: { argb: "FFD1D5DB" } };
  return { top: side, left: side, bottom: side, right: side };
}
function solid(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}
function fmtClock(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  const s = Math.round(secs % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function buildAnalyticsWorkbook(d: Analytics): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Backend Tracker";
  wb.created = new Date();

  const headerFill = solid("FF6D28D9");
  const titleColor = { argb: "FF3B0764" };

  const rangeLabel =
    d.meta.from || d.meta.to
      ? `${d.meta.from ?? "start"} → ${d.meta.to ?? "now"}`
      : "All time";
  const generated = new Date(d.meta.generatedAt).toLocaleString("en-US", { timeZone: TZ });

  // ── Sheet 1: Overview ──
  const ov = wb.addWorksheet("Overview");
  ov.getColumn(1).width = 40;
  ov.getColumn(2).width = 22;
  let r = 1;
  const title = ov.getCell(r, 1);
  title.value = `Onboarding Team — Performance Analysis  ${d.meta.line}`;
  title.font = { bold: true, size: 16, color: titleColor };
  r += 1;
  const sub = ov.getCell(r, 1);
  sub.value = `Range: ${rangeLabel}  •  ${d.meta.totalAgents} agents  •  Generated ${generated} (LA)`;
  sub.font = { italic: true, size: 10, color: { argb: "FF666666" } };
  r += 2;

  const kv = (k: string, v: string | number, bold = false) => {
    const kc = ov.getCell(r, 1);
    kc.value = k;
    kc.border = thinBorder();
    const vc = ov.getCell(r, 2);
    vc.value = v;
    vc.alignment = { horizontal: "right" };
    vc.border = thinBorder();
    if (bold) vc.font = { bold: true };
    r++;
  };
  const section = (label: string) => {
    const c = ov.getCell(r, 1);
    c.value = label;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = headerFill;
    c.border = thinBorder();
    const c2 = ov.getCell(r, 2);
    c2.fill = headerFill;
    c2.border = thinBorder();
    r++;
  };

  section("Key Metrics");
  kv("Total calls", d.kpis.totalCalls);
  kv("Inbound received", d.kpis.inboundReceived);
  kv("Inbound answered", d.kpis.inboundAnswered);
  kv("Inbound missed", d.kpis.inboundMissed);
  kv("Response rate", `${d.kpis.responseRate}%`, true);
  kv("1st ring response rate", `${d.kpis.firstRingResponseRate}%`, true);
  kv("1st ring answered", d.kpis.firstRingAnswered);
  kv("1st ring missed", d.kpis.firstRingMissed);
  kv("1st ring attempts", d.kpis.firstRingAttempts);
  kv("Missed-call ratio", `${d.kpis.missedRatio}%`, true);
  kv("Outbound calls", d.kpis.outbound);
  kv("Total talk time", fmtClock(d.kpis.talkSeconds));
  kv("Avg talk / answered call", fmtClock(d.kpis.avgTalkSec));
  kv("Avg available between calls", `${d.kpis.avgGapMin} min`);
  r++;

  const hr = (h: number | null) => (h === null ? "—" : `${String(h).padStart(2, "0")}:00`);
  section("Daily Patterns");
  kv("Busiest hour", hr(d.peaks.busiestHour));
  kv("Most missed-calls hour", hr(d.peaks.mostMissedHour));
  kv("Most available hour", hr(d.peaks.mostAvailableHour));
  r++;

  section("What Can Be Improved");
  for (const ins of d.insights) {
    const c = ov.getCell(r, 1);
    ov.mergeCells(r, 1, r, 2);
    c.value = `•  ${ins}`;
    c.alignment = { wrapText: true, vertical: "top" };
    ov.getRow(r).height = 30;
    c.border = thinBorder();
    r++;
  }

  // ── Sheet 2: Agent Ranking ──
  const ws = wb.addWorksheet("Agent Ranking", { views: [{ state: "frozen", ySplit: 1 }] });
  const cols = [
    "Rank",
    "Agent",
    "Total Calls",
    "Inbound",
    "Outbound",
    "Answered",
    "Missed",
    "Response Rate %",
    "1st Ring Response %",
    "1st Ring Answered",
    "1st Ring Missed",
    "1st Ring Attempts",
    "Missed Ratio %",
    "Avg Gap (min)",
    "Talk Time",
    "Customers",
    "Onboarded",
    "Connection",
    "Onboarded %",
  ];
  const widths = [6, 22, 12, 10, 10, 10, 9, 16, 18, 16, 14, 16, 14, 13, 12, 11, 11, 11, 13];
  cols.forEach((c, i) => {
    ws.getColumn(i + 1).width = widths[i]!;
    const cell = ws.getCell(1, i + 1);
    cell.value = c;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = headerFill;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder();
  });
  let rr = 2;
  let rank = 1;
  for (const a of d.agents) {
    const row = ws.getRow(rr);
    row.getCell(1).value = a.ranked ? rank++ : "";
    row.getCell(2).value = a.overflow ? `${a.name} — unanswered overflow (not an agent)` : a.name;
    row.getCell(3).value = a.totalCalls;
    row.getCell(4).value = a.inbound;
    row.getCell(5).value = a.outbound;
    row.getCell(6).value = a.answered;
    row.getCell(7).value = a.missed;
    row.getCell(8).value = a.responseRate;
    row.getCell(9).value = a.firstRingResponseRate;
    row.getCell(10).value = a.firstRingAnswered;
    row.getCell(11).value = a.firstRingMissed;
    row.getCell(12).value = a.firstRingAttempts;
    row.getCell(13).value = a.missedRatio;
    row.getCell(14).value = a.avgGapMin;
    row.getCell(15).value = fmtClock(a.talkSeconds);
    row.getCell(16).value = a.uniqueContacts;
    row.getCell(17).value = a.onboarded;
    row.getCell(18).value = a.connection;
    row.getCell(19).value = a.onboardedRate;
    const rc = row.getCell(8);
    rc.fill = a.responseRate >= 85 ? solid("FFDCFCE7") : a.responseRate >= 70 ? solid("FFFEF9C3") : solid("FFFEE2E2");
    const frc = row.getCell(9);
    frc.fill = a.firstRingResponseRate >= 85 ? solid("FFDCFCE7") : a.firstRingResponseRate >= 70 ? solid("FFFEF9C3") : solid("FFFEE2E2");
    for (let c = 1; c <= cols.length; c++) row.getCell(c).border = thinBorder();
    if (!a.ranked) row.getCell(2).font = { italic: true, color: { argb: "FF9CA3AF" } };
    rr++;
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rr - 1), column: cols.length } };

  // ── Sheet 3: 1st Ring Details ──
  const frs = wb.addWorksheet("1st Ring Details", { views: [{ state: "frozen", ySplit: 1 }] });
  const frCols = ["Agent", "Customer Number", "Normalized Number", "First Inbound At", "Answered", "Status", "Line", "Source"];
  const frWidths = [24, 18, 18, 24, 11, 16, 22, 16];
  frCols.forEach((c, i) => {
    frs.getColumn(i + 1).width = frWidths[i]!;
    const cell = frs.getCell(1, i + 1);
    cell.value = c;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = headerFill;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder();
  });
  let frn = 2;
  for (const a of d.agents) {
    for (const detail of a.firstRingDetails) {
      const row = frs.getRow(frn);
      row.getCell(1).value = detail.agent;
      row.getCell(2).value = detail.customerNumber;
      row.getCell(3).value = detail.normalizedNumber;
      row.getCell(4).value = new Date(detail.firstInboundAt).toLocaleString("en-US", { timeZone: TZ });
      row.getCell(5).value = detail.answered ? "Answered" : "Missed";
      row.getCell(6).value = detail.status;
      row.getCell(7).value = detail.line;
      row.getCell(8).value = detail.source;
      row.getCell(5).fill = detail.answered ? solid("FFDCFCE7") : solid("FFFEE2E2");
      for (let c = 1; c <= frCols.length; c++) row.getCell(c).border = thinBorder();
      frn++;
    }
  }
  frs.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, frn - 1), column: frCols.length } };

  // ── Sheet 4: By Hour ──
  const hsheet = wb.addWorksheet("By Hour of Day");
  const hcols = ["Hour (LA)", "Total Calls", "Inbound", "Missed", "Missed %", "Avg Idle Min Between Calls"];
  const hw = [12, 12, 10, 9, 11, 14];
  hcols.forEach((c, i) => {
    hsheet.getColumn(i + 1).width = hw[i]!;
    const cell = hsheet.getCell(1, i + 1);
    cell.value = c;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = headerFill;
    cell.alignment = { horizontal: "center", wrapText: true };
    cell.border = thinBorder();
  });
  let hrn = 2;
  for (const h of d.hourly) {
    const row = hsheet.getRow(hrn);
    row.getCell(1).value = `${String(h.hour).padStart(2, "0")}:00`;
    row.getCell(2).value = h.calls;
    row.getCell(3).value = h.inbound;
    row.getCell(4).value = h.missed;
    row.getCell(5).value = h.inbound > 0 ? Math.round((h.missed / h.inbound) * 100) : 0;
    row.getCell(6).value = h.idleMinutes;
    for (let c = 1; c <= hcols.length; c++) row.getCell(c).border = thinBorder();
    if (d.peaks.mostMissedHour === h.hour) row.getCell(4).fill = solid("FFFEE2E2");
    if (d.peaks.mostAvailableHour === h.hour) row.getCell(6).fill = solid("FFDBEAFE");
    hrn++;
  }

  // ── Sheet 5: Cassie Spotlight ──
  const cs = wb.addWorksheet("Cassie Spotlight");
  cs.getColumn(1).width = 36;
  cs.getColumn(2).width = 18;
  cs.getColumn(3).width = 18;
  let cr = 1;
  const ct = cs.getCell(cr, 1);
  ct.value = "Cassie Lynn — Productivity & Problem-Solving";
  ct.font = { bold: true, size: 14, color: titleColor };
  cr += 2;
  if (!d.cassie) {
    cs.getCell(cr, 1).value = "No calls for Cassie Lynn in this range.";
  } else {
    const c = d.cassie;
    const head = (a: string, b: string, cc: string) => {
      const cells = [a, b, cc];
      cells.forEach((v, i) => {
        const cell = cs.getCell(cr, i + 1);
        cell.value = v;
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = headerFill;
        cell.border = thinBorder();
      });
      cr++;
    };
    const row3 = (k: string, v: string | number, vs?: string) => {
      cs.getCell(cr, 1).value = k;
      cs.getCell(cr, 1).border = thinBorder();
      cs.getCell(cr, 2).value = v;
      cs.getCell(cr, 2).alignment = { horizontal: "right" };
      cs.getCell(cr, 2).border = thinBorder();
      if (vs !== undefined) {
        cs.getCell(cr, 3).value = vs;
        cs.getCell(cr, 3).alignment = { horizontal: "right" };
        cs.getCell(cr, 3).border = thinBorder();
      }
      cr++;
    };
    head("Metric", "Cassie", "vs Team");
    row3("Total calls handled", c.totalCalls);
    row3("Inbound received", c.inbound);
    row3("Inbound answered", c.answered);
    row3("Response rate", `${c.responseRate}%`, `${c.vsTeam.responseRate >= 0 ? "+" : ""}${c.vsTeam.responseRate} pts`);
    row3("Missed ratio", `${c.missedRatio}%`);
    row3("Unique customers", c.uniqueContacts);
    row3("Total talk time", fmtClock(c.talkSeconds));
    row3("Avg available between calls", `${c.avgGapMin} min`, `${c.vsTeam.avgGapMin >= 0 ? "+" : ""}${c.vsTeam.avgGapMin} min`);
    cr++;
    head("Problem Solving", "Cassie", "vs Team");
    row3("Customers onboarded", c.onboarded);
    row3("Connection-only calls", c.connection);
    row3("Onboarded conversion", `${c.onboardedRate}%`, `${c.vsTeam.onboardedRate >= 0 ? "+" : ""}${c.vsTeam.onboardedRate} pts`);
    row3("Calls mentioning tax", c.taxMentions);
  }

  return wb;
}

export default router;
