import { Router, type IRouter } from "express";
import { db, phoneCallsTable } from "@workspace/db";
import { and, eq, gte, lte, desc, ne } from "drizzle-orm";
import { runSync, startBackgroundSync, getSyncState, USER_EMAIL_OVERRIDES, USER_ID_OVERRIDES } from "./quoSync.js";
import { getBlockedNumbers } from "../lib/blockedNumbers.js";
import { logger } from "../lib/logger.js";
import { liveWebhookCalls } from "./quoWebhook.js";

const router: IRouter = Router();

// ─── California date helpers ──────────────────────────────────────────────────
// All stats are grouped and filtered by California (Pacific) date so they match
// what the OpenPhone admin panel shows.

/** Format a UTC Date as a YYYY-MM-DD string in California time. */
function toCaDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/**
 * Given a YYYY-MM-DD string treated as a California calendar date, return the
 * UTC [from, to) bounds that span exactly that California day.
 * Handles PDT (UTC-7) and PST (UTC-8) automatically.
 */
function caDateBounds(dateStr: string): { from: Date; to: Date } {
  // Midnight PDT = 07:00 UTC; midnight PST = 08:00 UTC.
  // Try 07:00 first; if that still lands on a different CA date, use 08:00.
  const pdtMidnight = new Date(`${dateStr}T07:00:00Z`);
  const fromMs = toCaDate(pdtMidnight) === dateStr
    ? pdtMidnight.getTime()
    : pdtMidnight.getTime() + 60 * 60 * 1000; // PST offset
  return { from: new Date(fromMs), to: new Date(fromMs + 24 * 60 * 60 * 1000) };
}

/**
 * Parse `from` / `to` query-param strings into UTC Date bounds.
 * Date-only strings (YYYY-MM-DD) are treated as California calendar dates so
 * the query window matches what agents and OpenPhone show locally.
 */
function parseDateRange(from: string, to: string): { fromDate: Date; toDate: Date } {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const fromDate = DATE_RE.test(from) ? caDateBounds(from).from : new Date(from);
  const toDate   = DATE_RE.test(to)   ? caDateBounds(to).to   : new Date(to);
  return { fromDate, toDate };
}

const QUO_BASE = "https://api.openphone.com/v1";

function quoHeaders(): Record<string, string> {
  const key = process.env["QUO_API_KEY"];
  if (!key) throw new Error("QUO_API_KEY not configured");
  return { Authorization: key, Accept: "application/json" };
}

async function quoFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${QUO_BASE}${path}`, { headers: quoHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Quo API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

interface QuoPhoneNumber {
  id: string;
  name: string;
  formattedNumber: string;
  number: string;
  users: { id: string; firstName: string; lastName: string; email: string }[];
}

// Exact line name → team (mirrors quoSync.ts LINE_TEAM_MAP)
const LINE_TEAM_MAP: Record<string, "retention" | "nsf" | "cs"> = {
  "ahmed ayman-levi miller":         "retention", // Ahmed Ayman → Retention
  "youssef nady-jacob xander":       "cs",
  "nour-michael belfort-2900":       "retention", // Michael Belfort → Retention
  "levi ob":                         "retention", // Ahmed Ayman → Retention
  "levi cs ob":                      "retention", // Ahmed Ayman → Retention
  "talia nsf":                       "retention", // Talia Morgan → Retention
  "talia morgan cs ob":              "retention", // Talia Morgan → Retention
  "jacob ob":                        "cs",
  "jacob cs ob":                     "retention", // Jacob Xander → Retention
  "adam ob":                         "retention",
  "rick ob":                         "retention",
  "ryan ob":                         "retention",
  "abdlrhman-jacob stephenson":      "retention",
  "zeiad fouad-zack ford":           "retention",
  "mohammed ayman-max francis-2268": "retention",
  "max - ma":                        "retention",
};

function classifyLine(name: string): "retention" | "nsf" | "cs" | null {
  const n = name.toLowerCase().trim();
  if (n in LINE_TEAM_MAP) return LINE_TEAM_MAP[n];
  if (/\bcs\b|customer support|talia|hiba|nourhan|rasha|bassant|ella monroe/.test(n) || name === "CS Team") return "cs";
  if (/retention|ob|outbound|ryan|abdlrhman|rick|zeiad|zack|henry.?hart|katherine|karma/.test(n)) return "retention";
  if (/nsf|national settlement|ellie|alex|katie|jenny|estella|rika|austin/.test(n)) return "nsf";
  return null;
}

// Agent-name → team override. Calls are bucketed by who made them, not which line
// they used. This ensures agents who call from shared/unclassified lines still
// appear in the correct team bucket.
const AGENT_TEAM: Record<string, "retention" | "nsf" | "cs"> = {
  // Retention — current roster (May 2026)
  "ryan henderson":    "retention",
  "henry hart":        "retention",
  "katherine adams":   "retention",
  "jacob stephenson":  "retention",
  "abdulrhman isawi":  "retention",
  "rick miller":       "retention",
  "zeiad fouad":       "retention",
  "max francis":       "retention",
  "mohammed ayman":    "retention",
  "leo carter":        "cs",
  "fares":             "cs",
  // NSF
  "alex cruz":         "nsf",
  "austin white":      "nsf",
  "rika hart":         "nsf",
  "jenny morgan":      "nsf",
  "estella cruz":      "nsf",
  "katie miller":      "nsf",
  "ellie moser":       "nsf",
  // Retention — agents moved from CS
  "ahmed ayman":       "retention",
  "levi miller":       "retention",
  "michael belfort":   "retention",
  "talia morgan":      "retention",
  // CS
  "chase miller":      "cs",
  "nour eldin atef":   "cs",
  "youssef nady":      "cs",
  "jacob xander":      "cs",
  "ella monroe":       "cs",
  "nora adam":         "cs",
  "carla bennet":      "cs",
};

function agentTeam(agentName: string): "retention" | "nsf" | "cs" | null {
  const key = agentName.toLowerCase().trim();
  return AGENT_TEAM[key] ?? null;
}

router.get("/quo/lines", async (req, res) => {
  try {
    const result = await quoFetch<{ data: QuoPhoneNumber[] }>("/phone-numbers");
    const classified = (result.data ?? [])
      .map((p) => ({ ...p, team: classifyLine(p.name) }))
      .filter((p) => p.team !== null);
    res.json({ data: classified });
  } catch (err) {
    req.log.error(err, "quo lines error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/quo/all-lines", async (req, res) => {
  try {
    const result = await quoFetch<{ data: QuoPhoneNumber[] }>("/phone-numbers");
    const lines = (result.data ?? [])
      .filter((p) => !p.name.toLowerCase().includes("tax"))
      .map((p) => ({ ...p, team: classifyLine(p.name) }));
    res.json({ data: lines });
  } catch (err) {
    req.log.error(err, "quo all-lines error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/quo/line-stats", async (req, res) => {
  try {
    const from = (req.query["from"] as string) || new Date(Date.now() - 30 * 86400000).toISOString();
    const to = (req.query["to"] as string) || new Date().toISOString();
    const lineId = req.query["lineId"] as string | undefined;

    if (!lineId) {
      res.status(400).json({ error: "lineId is required" });
      return;
    }

    const { fromDate, toDate } = parseDateRange(from, to);

    const rows = await db
      .select({
        agentName: phoneCallsTable.agentName,
        participant: phoneCallsTable.participant,
        direction: phoneCallsTable.direction,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        postAnswerSeconds: phoneCallsTable.postAnswerSeconds,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(and(eq(phoneCallsTable.lineId, lineId), gte(phoneCallsTable.createdAt, fromDate), lte(phoneCallsTable.createdAt, toDate), ne(phoneCallsTable.status, "in-progress")));

    type Slot = {
      outbound: number; inbound: number; answered: number; missed: number;
      voicemail: number; vmBrief: number; totalCalls: number; talkSeconds: number;
      uniqueContacts: Set<string>;
    };

    const agentStats: Record<string, Record<string, Slot>> = {};
    const agentLastCall: Record<string, Date> = {};
    // Track unique contacts across the FULL date range per agent (not per day)
    // so the total "CX Reached" is truly deduplicated.
    const agentUniqueContactsAll: Record<string, Set<string>> = {};
    const blocklist = await getBlockedNumbers();
    const lineInbounds = { total: 0, answered: 0, missed: 0 };

    for (const row of rows) {
      if (row.participant && blocklist.has(row.participant)) continue;
      // Track ALL inbound calls at the line level regardless of attribution
      if (row.direction === "incoming") {
        lineInbounds.total++;
        if (row.status === "completed") lineInbounds.answered++;
        else lineInbounds.missed++;
      }

      const agentName = row.agentName ?? "Unknown";
      const date = toCaDate(row.createdAt);

      if (!agentStats[agentName]) agentStats[agentName] = {};
      if (!agentStats[agentName][date]) {
        agentStats[agentName][date] = {
          outbound: 0, inbound: 0, answered: 0, missed: 0,
          voicemail: 0, vmBrief: 0, totalCalls: 0, talkSeconds: 0, uniqueContacts: new Set(),
        };
      }
      const slot = agentStats[agentName][date];
      slot.totalCalls++;
      slot.talkSeconds += row.durationSeconds;

      if (row.participant) {
        // Per-day unique contacts — both inbound and outbound (for "by day" sub-tab)
        slot.uniqueContacts.add(row.participant);
        // Cross-range unique (for totals column)
        if (!agentUniqueContactsAll[agentName]) agentUniqueContactsAll[agentName] = new Set();
        agentUniqueContactsAll[agentName].add(row.participant);
      }
      const endTime = new Date(row.createdAt.getTime() + row.durationSeconds * 1000);
      if (!agentLastCall[agentName] || endTime > agentLastCall[agentName]) {
        agentLastCall[agentName] = endTime;
      }

      if (row.direction === "outgoing") slot.outbound++;
      else slot.inbound++;

      let effectiveStatus = row.status;
      if (row.status === "completed" && row.direction === "outgoing") {
        const pas = row.postAnswerSeconds;
        if (pas !== null && pas !== undefined) {
          if (pas >= 60) effectiveStatus = "completed";
          else if (pas >= 20) effectiveStatus = "voicemail";
          else effectiveStatus = "voicemail-brief";
        } else {
          const dur = row.durationSeconds;
          if (dur >= 75) effectiveStatus = "completed";
          else if (dur >= 35) effectiveStatus = "voicemail";
          else effectiveStatus = "voicemail-brief";
        }
      }

      if (effectiveStatus === "completed") slot.answered++;
      else if (effectiveStatus === "voicemail") slot.voicemail++;
      else if (effectiveStatus === "voicemail-brief") slot.vmBrief++;
      else slot.missed++;
    }

    const serializedStats: Record<string, Record<string, unknown>> = {};
    for (const [agent, days] of Object.entries(agentStats)) {
      serializedStats[agent] = {};
      for (const [date, slot] of Object.entries(days)) {
        serializedStats[agent][date] = { ...slot, uniqueContacts: slot.uniqueContacts.size };
      }
    }

    const serializedLastCall: Record<string, string> = {};
    for (const [agent, ts] of Object.entries(agentLastCall)) {
      serializedLastCall[agent] = ts.toISOString();
    }

    // True unique contacts across the full date range per agent
    const serializedUniqueAll: Record<string, number> = {};
    for (const [agent, set] of Object.entries(agentUniqueContactsAll)) {
      serializedUniqueAll[agent] = set.size;
    }

    res.json({ agentStats: serializedStats, agentLastCall: serializedLastCall, lineInbounds, agentUniqueContactsAll: serializedUniqueAll });
  } catch (err) {
    req.log.error(err, "quo line-stats error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/quo/stats", async (req, res) => {
  try {
    const from = (req.query["from"] as string) || new Date(Date.now() - 30 * 86400000).toISOString();
    const to = (req.query["to"] as string) || new Date().toISOString();

    const { fromDate, toDate } = parseDateRange(from, to);

    const rows = await db
      .select({
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        lineId: phoneCallsTable.lineId,
        agentName: phoneCallsTable.agentName,
        agentId: phoneCallsTable.agentId,
        participant: phoneCallsTable.participant,
        direction: phoneCallsTable.direction,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.createdAt, fromDate), lte(phoneCallsTable.createdAt, toDate), ne(phoneCallsTable.status, "in-progress")));

    const teamStats: Record<
      string,
      Record<
        string,
        Record<
          string,
          {
            outbound: number;
            inbound: number;
            answered: number;
            missed: number;
            voicemail: number;
            vmBrief: number;
            totalCalls: number;
            talkSeconds: number;
            uniqueContacts: Set<string>;
          }
        >
      >
    > = { retention: {}, nsf: {}, cs: {} };

    const agentLastCall: Record<string, Record<string, Date>> = {};

    const lineInbound: Record<
      string,
      Record<string, { lineId: string; lineName: string; received: number; answered: number; missed: number; voicemail: number }>
    > = {};

    const blocklist = await getBlockedNumbers();
    for (const row of rows) {
      if (row.participant && blocklist.has(row.participant)) continue;
      const agentName = row.agentName ?? "Unknown";
      // Agent-based team takes priority over line-based; skip calls from unknown agents
      const team = agentTeam(agentName) ?? row.lineTeam;
      if (!team || !(team in teamStats)) continue;
      const date = toCaDate(row.createdAt);

      if (!teamStats[team]) teamStats[team] = {};
      if (!teamStats[team][agentName]) teamStats[team][agentName] = {};
      if (!teamStats[team][agentName][date]) {
        teamStats[team][agentName][date] = {
          outbound: 0, inbound: 0, answered: 0, missed: 0,
          voicemail: 0, vmBrief: 0, totalCalls: 0, talkSeconds: 0, uniqueContacts: new Set(),
        };
      }
      const slot = teamStats[team][agentName][date];
      slot.totalCalls++;
      slot.talkSeconds += row.durationSeconds;
      // "CX Reached" = unique phone numbers spoken with, inbound OR outbound (skip blanks)
      if (row.participant) slot.uniqueContacts.add(row.participant);
      if (!agentLastCall[team]) agentLastCall[team] = {};
      const endTimeTeam = new Date(row.createdAt.getTime() + row.durationSeconds * 1000);
      if (!agentLastCall[team][agentName] || endTimeTeam > agentLastCall[team][agentName]) {
        agentLastCall[team][agentName] = endTimeTeam;
      }
      if (row.direction === "outgoing") slot.outbound++;
      else slot.inbound++;

      // For outbound "completed" calls, re-apply effectiveStatus logic at query time.
      // Old records (synced before the fix) have post_answer_seconds=null and status="completed"
      // even when the call only hit voicemail. Fall back to duration_seconds with adjusted
      // thresholds (+15s to account for typical ring time) when post_answer_seconds is missing.
      let effectiveStatus = row.status;
      if (row.status === "completed" && row.direction === "outgoing") {
        const pas = row.postAnswerSeconds;
        if (pas !== null && pas !== undefined) {
          // Precise: use actual post-answer seconds
          if (pas >= 60) effectiveStatus = "completed";
          else if (pas >= 20) effectiveStatus = "voicemail";
          else effectiveStatus = "voicemail-brief";
        } else {
          // Approximate: duration includes ~15s ring time, so adjust thresholds up by 15s
          const dur = row.durationSeconds;
          if (dur >= 75) effectiveStatus = "completed";
          else if (dur >= 35) effectiveStatus = "voicemail";
          else effectiveStatus = "voicemail-brief";
        }
      }

      if (effectiveStatus === "completed") slot.answered++;
      else if (effectiveStatus === "voicemail") slot.voicemail++;
      else if (effectiveStatus === "voicemail-brief") slot.vmBrief++;
      else slot.missed++;

      if (row.direction === "incoming") {
        if (!lineInbound[row.lineId]) lineInbound[row.lineId] = {};
        if (!lineInbound[row.lineId][date]) {
          lineInbound[row.lineId][date] = { lineId: row.lineId, lineName: row.lineName, received: 0, answered: 0, missed: 0, voicemail: 0 };
        }
        const lb = lineInbound[row.lineId][date];
        lb.received++;
        if (row.status === "completed") lb.answered++;
        else if (row.status === "voicemail") lb.voicemail++;
        else lb.missed++;
      }
    }

    const serializeStats = () => {
      const out: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const [team, agents] of Object.entries(teamStats)) {
        out[team] = {};
        for (const [agent, days] of Object.entries(agents)) {
          out[team][agent] = {};
          for (const [date, slot] of Object.entries(days)) {
            out[team][agent][date] = { ...slot, uniqueContacts: slot.uniqueContacts.size };
          }
        }
      }
      return out;
    };

    const syncState = await getSyncState();

    const agentLastCallSerialized: Record<string, Record<string, string>> = {};
    for (const [team, agents] of Object.entries(agentLastCall)) {
      agentLastCallSerialized[team] = {};
      for (const [agent, ts] of Object.entries(agents)) {
        agentLastCallSerialized[team][agent] = ts.toISOString();
      }
    }

    res.json({
      teamStats: serializeStats(),
      lineInbound,
      agentLastCall: agentLastCallSerialized,
      totalRows: rows.length,
      lastSyncedAt: syncState?.lastSyncedAt ?? null,
      isSyncing: syncState?.isSyncing ?? false,
    });
  } catch (err) {
    req.log.error(err, "quo stats error");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/quo/sync", async (req, res) => {
  try {
    const from = (req.body?.from as string) || new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const to = (req.body?.to as string) || new Date().toISOString();
    req.log.info({ from, to }, "quo sync triggered manually");
    res.json({ success: true, message: "Sync started in background", from, to });
    runSync(new Date(from), new Date(to)).catch((err) => {
      req.log.error(err, "quo manual sync background error");
    });
  } catch (err) {
    req.log.error(err, "quo sync error");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/quo/sync-state", async (req, res) => {
  try {
    const state = await getSyncState();
    res.json(state ?? { id: "singleton", lastSyncedAt: null, isSyncing: false });
  } catch (err) {
    req.log.error(err, "quo sync state error");
    res.status(500).json({ error: String(err) });
  }
});

// ─── Live-call detection ───────────────────────────────────────────────────────
// Three sources merged in /quo/live:
//   1. Webhook state   — instant (set by quoWebhook.ts on call.ringing / call.answered)
//   2. Poll state      — 60-second background poll; queries conversations updated in
//                        the last 5 min, then fetches calls for each to find in-progress
//   3. DB fallback     — catches calls synced by the 15-min background sync

// ─── 60-second background live poller ─────────────────────────────────────────
// Finds in-progress calls by scanning conversations updated in the last 5 minutes.
// Fills the gap between webhook events (often not configured) and the 15-min DB sync.
const pollLiveAgents = new Set<string>();
/** agentName → external participant number for the current in-progress call */
const pollLiveParticipants = new Map<string, string>();
let livePollRunning = false;

async function runLivePoll(): Promise<void> {
  if (livePollRunning) return;
  livePollRunning = true;
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // Build userId → agentName map AND collect line IDs in one call
    type OPUser = { id: string; firstName: string; lastName: string; email?: string };
    const [usersRes, linesRes] = await Promise.all([
      quoFetch<{ data: OPUser[] }>("/users").catch(() => ({ data: [] as OPUser[] })),
      quoFetch<{ data: { id: string; users?: OPUser[] }[] }>("/phone-numbers").catch(() => ({ data: [] as { id: string; users?: OPUser[] }[] })),
    ]);
    const userMap = new Map<string, string>();
    function addToUserMap(u: OPUser) {
      if (userMap.has(u.id)) return;
      const emailKey = u.email?.toLowerCase().trim() ?? "";
      const override = USER_ID_OVERRIDES[u.id] ?? (emailKey && USER_EMAIL_OVERRIDES[emailKey]);
      userMap.set(u.id, override || `${u.firstName} ${u.lastName}`.trim());
    }
    for (const u of usersRes.data ?? []) addToUserMap(u);
    for (const line of linesRes.data ?? []) for (const u of line.users ?? []) addToUserMap(u);

    const lineIds = new Set(linesRes.data.map((l) => l.id));

    // Conversations updated in last 5 minutes = potentially active calls
    const convRes = await quoFetch<{
      data: { id: string; phoneNumberId: string; participants: string[] }[];
    }>(`/conversations?updatedAfter=${encodeURIComponent(fiveMinAgo)}&updatedBefore=${encodeURIComponent(now)}&maxResults=100`)
      .catch(() => ({ data: [] as { id: string; phoneNumberId: string; participants: string[] }[] }));

    const newLive = new Set<string>();
    const newParticipants = new Map<string, string>();

    // For each recently-active conversation, check for in-progress calls
    const tasks = (convRes.data ?? [])
      .filter((c) => lineIds.has(c.phoneNumberId) && c.participants?.length > 0)
      .map((c) => async () => {
        const participant = c.participants[0];
        type LiveCall = {
          id: string;
          status: string;
          userId?: string | null;
          participants?: string[];
          users?: { id?: string; firstName?: string; lastName?: string; email?: string }[];
          answeredBy?: string | null;
          // OpenPhone occasionally returns an array of user ids that handled the call.
          userIds?: string[];
        };
        const callsRes = await quoFetch<{ data: LiveCall[] }>(
          `/calls?phoneNumberId=${encodeURIComponent(c.phoneNumberId)}` +
          `&participants[]=${encodeURIComponent(participant)}` +
          `&createdAfter=${encodeURIComponent(fiveMinAgo)}` +
          `&createdBefore=${encodeURIComponent(now)}` +
          `&maxResults=5`,
        ).catch(() => ({ data: [] as LiveCall[] }));

        for (const call of callsRes.data ?? []) {
          if (call.status !== "in-progress") continue;

          // Resolve user via every known shape OpenPhone returns:
          //  - call.userId (single)
          //  - call.answeredBy (sometimes used for inbound)
          //  - call.userIds[0]
          //  - call.users[0].id
          const inlineUser = call.users?.[0];
          if (inlineUser?.id) addToUserMap({
            id: inlineUser.id,
            firstName: inlineUser.firstName ?? "",
            lastName: inlineUser.lastName ?? "",
            email: inlineUser.email,
          });
          const resolvedUserId =
            call.userId ??
            call.answeredBy ??
            call.userIds?.[0] ??
            inlineUser?.id ??
            null;

          if (!resolvedUserId) {
            logger.warn(
              { callId: call.id, phoneNumberId: c.phoneNumberId, participant },
              "quo livePoll: in-progress call with no resolvable user",
            );
            continue;
          }

          const agentName = userMap.get(resolvedUserId) ?? resolvedUserId;
          if (agentName === resolvedUserId) {
            logger.warn(
              { callId: call.id, userId: resolvedUserId, phoneNumberId: c.phoneNumberId },
              "quo livePoll: in-progress user id not in userMap",
            );
          }
          newLive.add(agentName);
          const liveParticipant = call.participants?.[0] ?? participant;
          newParticipants.set(agentName, liveParticipant);
        }
      });

    // Run up to 8 concurrent checks
    const limit = 8;
    let idx = 0;
    async function worker() {
      while (idx < tasks.length) {
        const task = tasks[idx++];
        if (task) await task().catch(() => {});
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));

    pollLiveAgents.clear();
    pollLiveParticipants.clear();
    for (const a of newLive) pollLiveAgents.add(a);
    for (const [a, p] of newParticipants) pollLiveParticipants.set(a, p);

    if (newLive.size > 0) {
      logger.info({ agents: [...newLive] }, "quo livePoll: in-progress calls found");
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "quo livePoll: error");
  } finally {
    livePollRunning = false;
  }
}

// Start the 60-second live poller immediately on module load
runLivePoll().catch(() => {});
setInterval(() => { runLivePoll().catch(() => {}); }, 60_000);


router.get("/quo/live", async (req, res) => {
  try {
    const active = new Set<string>();

    // Source 1: webhook in-memory state — instant, set by quoWebhook.ts on call.ringing/answered.
    for (const { agentName } of liveWebhookCalls.values()) active.add(agentName);

    // Source 2: 60-second background poll — finds in-progress calls via conversations API.
    // Covers the gap when webhooks miss an event.
    for (const agentName of pollLiveAgents) active.add(agentName);

    // Source 3: DB in-progress rows — catches calls synced by the 15-min background sync.
    const since2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const dbRows = await db
      .select({ agentName: phoneCallsTable.agentName, participant: phoneCallsTable.participant })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.syncedAt, since2h), eq(phoneCallsTable.status, "in-progress")));
    for (const r of dbRows) if (r.agentName) active.add(r.agentName);

    // Build agentName → participant map.
    // Priority: poll (fresh from call record) → DB → webhook (from/to at ring time)
    const agentParticipant = new Map<string, string | null>();
    // Lowest priority first — webhook number at ring time
    for (const { agentName, participant } of liveWebhookCalls.values()) {
      agentParticipant.set(agentName, participant || null);
    }
    // Poll participant (from call record, updated each 60s)
    for (const agentName of pollLiveAgents) {
      agentParticipant.set(agentName, pollLiveParticipants.get(agentName) ?? agentParticipant.get(agentName) ?? null);
    }
    // DB participant (most stable — from completed-call upsert)
    for (const r of dbRows) {
      if (r.agentName && r.participant) agentParticipant.set(r.agentName, r.participant);
    }

    req.log.info(
      { fromWebhook: liveWebhookCalls.size, fromPoll: pollLiveAgents.size, total: active.size },
      "quo live"
    );
    res.json({
      active: [...active],
      agentCalls: [...agentParticipant.entries()].map(([agentName, participant]) => ({ agentName, participant })),
      webhookActive: liveWebhookCalls.size > 0,
    });
  } catch (err) {
    req.log.error(err, "quo live error");
    res.status(500).json({ error: String(err) });
  }
});


router.get("/quo/calls", async (req, res) => {
  try {
    const from = (req.query["from"] as string) || new Date(Date.now() - 30 * 86400000).toISOString();
    const to = (req.query["to"] as string) || new Date().toISOString();
    const team = (req.query["team"] as string) || undefined;
    const limitParam = Math.min(Number(req.query["limit"] ?? 500), 1000);
    const offsetParam = Number(req.query["offset"] ?? 0);

    const { fromDate, toDate } = parseDateRange(from, to);

    const rows = await db
      .select({
        id: phoneCallsTable.id,
        lineTeam: phoneCallsTable.lineTeam,
        lineName: phoneCallsTable.lineName,
        agentName: phoneCallsTable.agentName,
        participant: phoneCallsTable.participant,
        direction: phoneCallsTable.direction,
        status: phoneCallsTable.status,
        durationSeconds: phoneCallsTable.durationSeconds,
        createdAt: phoneCallsTable.createdAt,
      })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.createdAt, fromDate), lte(phoneCallsTable.createdAt, toDate)))
      .orderBy(desc(phoneCallsTable.createdAt))
      .limit(limitParam)
      .offset(offsetParam);

    const filtered = team
      ? rows.filter((r) => {
          const effectiveTeam = (r.agentName ? agentTeam(r.agentName) : null) ?? r.lineTeam;
          return effectiveTeam === team;
        })
      : rows;

    res.json({ data: filtered, total: filtered.length });
  } catch (err) {
    req.log.error(err, "quo calls error");
    res.status(500).json({ error: String(err) });
  }
});

startBackgroundSync();

export { router as quoRouter };
export default router;
