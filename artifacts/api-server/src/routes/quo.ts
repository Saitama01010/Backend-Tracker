import { Router, type IRouter } from "express";
import { db, phoneCallsTable } from "@workspace/db";
import { and, eq, gte, lte, desc, ne } from "drizzle-orm";
import { runSync, startBackgroundSync, getSyncState } from "./quoSync.js";

const router: IRouter = Router();

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
};

function classifyLine(name: string): "retention" | "nsf" | "cs" | null {
  const n = name.toLowerCase().trim();
  if (n in LINE_TEAM_MAP) return LINE_TEAM_MAP[n];
  if (/\bcs\b|customer support|talia|hiba|nourhan|rasha|bassant|ella monroe/.test(n) || name === "CS Team") return "cs";
  if (/retention|ob|outbound|ryan|abdlrhman|rick|zeiad|zack|henry.?hart|chase.?miller|katherine|karma|leo.?carter|fares/.test(n)) return "retention";
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
  "chase miller":      "retention",
  "katherine adams":   "retention",
  "jacob stephenson":  "retention",
  "abdulrhman isawi":  "retention",
  "rick miller":       "retention",
  "zeiad fouad":       "retention",
  "leo carter":        "retention",
  // NSF
  "alex cruz":         "nsf",
  "austin white":      "nsf",
  "rika hart":         "nsf",
  "jenny morgan":      "nsf",
  "estella cruz":      "nsf",
  "katie miller":      "nsf",
  "ellie moser":       "nsf",
  // CS — includes agents moved from retention/nsf
  "ahmed ayman":       "cs",
  "levi miller":       "cs",
  "youssef nady":      "cs",
  "jacob xander":      "cs",
  "michael belfort":   "cs",
  "talia morgan":      "cs",
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

    const fromDate = new Date(from);
    const toDate = new Date(to);

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
    const lineInbounds = { total: 0, answered: 0, missed: 0 };

    for (const row of rows) {
      // Track ALL inbound calls at the line level regardless of attribution
      if (row.direction === "incoming") {
        lineInbounds.total++;
        if (row.status === "completed") lineInbounds.answered++;
        else lineInbounds.missed++;
      }

      const agentName = row.agentName ?? "Unknown";
      const date = row.createdAt.toISOString().slice(0, 10);

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

      if (row.direction === "outgoing" && row.participant) {
        // Per-day unique (for "by day" sub-tab)
        slot.uniqueContacts.add(row.participant);
        // Cross-range unique (for totals column)
        if (!agentUniqueContactsAll[agentName]) agentUniqueContactsAll[agentName] = new Set();
        agentUniqueContactsAll[agentName].add(row.participant);
      }
      if (!agentLastCall[agentName] || row.createdAt > agentLastCall[agentName]) {
        agentLastCall[agentName] = row.createdAt;
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

    const fromDate = new Date(from);
    const toDate = new Date(to);

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

    for (const row of rows) {
      const agentName = row.agentName ?? "Unknown";
      // Agent-based team takes priority over line-based; skip calls from unknown agents
      const team = agentTeam(agentName) ?? row.lineTeam;
      if (!team || !(team in teamStats)) continue;
      const date = row.createdAt.toISOString().slice(0, 10);

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
      // "Customers Reached" = unique phone numbers dialed outbound only (skip blanks)
      if (row.direction === "outgoing" && row.participant) slot.uniqueContacts.add(row.participant);
      if (!agentLastCall[team]) agentLastCall[team] = {};
      if (!agentLastCall[team][agentName] || row.createdAt > agentLastCall[team][agentName]) {
        agentLastCall[team][agentName] = row.createdAt;
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

router.get("/quo/live", async (req, res) => {
  try {
    // DB check: use syncedAt (refreshed on every re-sync) rather than createdAt
    // (the OpenPhone call-start time). A call running for 57 minutes has createdAt
    // from 57 min ago — it would fail a 15-min createdAt window. syncedAt is
    // stamped to now() on every upsert, so in-progress calls stay fresh across
    // sync cycles. 35 minutes covers at least 2 full sync cycles (15 min each).
    const since35 = new Date(Date.now() - 35 * 60 * 1000);
    const dbRows = await db
      .select({ agentName: phoneCallsTable.agentName })
      .from(phoneCallsTable)
      .where(and(gte(phoneCallsTable.syncedAt, since35), eq(phoneCallsTable.status, "in-progress")));
    const active = new Set(dbRows.map((r) => r.agentName).filter(Boolean) as string[]);

    // Real-time supplement: hit the OpenPhone conversations API for the last
    // 8 minutes to catch brand-new calls that haven't been synced into the DB yet.
    try {
      const since2 = new Date(Date.now() - 8 * 60 * 1000);
      const [convRes, linesRes] = await Promise.all([
        quoFetch<{ data: { id: string; phoneNumberId: string; participants: string[] }[] }>(
          `/conversations?updatedAfter=${encodeURIComponent(since2.toISOString())}&maxResults=50`
        ),
        quoFetch<{ data: { id: string; users: { id: string; firstName: string; lastName: string; email?: string }[] }[] }>(
          "/phone-numbers"
        ),
      ]);

      // Build a user ID → display name map from line membership
      const userMap = new Map<string, string>();
      for (const line of linesRes.data ?? []) {
        for (const u of line.users ?? []) {
          if (!userMap.has(u.id)) userMap.set(u.id, `${u.firstName} ${u.lastName}`.trim());
        }
      }

      // For each recent conversation fetch its recent calls (concurrency-limited)
      const convs = convRes.data ?? [];
      await Promise.all(
        convs.slice(0, 30).map(async (conv) => {
          if (!conv.phoneNumberId) return;
          const participant = conv.participants?.[0];
          if (!participant) return;
          try {
            const callsRes = await quoFetch<{ data: { status: string; userId?: string | null }[] }>(
              `/calls?phoneNumberId=${encodeURIComponent(conv.phoneNumberId)}` +
              `&participants[]=${encodeURIComponent(participant)}` +
              `&createdAfter=${encodeURIComponent(since2.toISOString())}&maxResults=10`
            );
            for (const call of callsRes.data ?? []) {
              if (call.status === "in-progress" && call.userId) {
                const name = userMap.get(call.userId);
                if (name) active.add(name);
              }
            }
          } catch { /* best-effort per conversation */ }
        })
      );
    } catch (apiErr) {
      req.log.warn({ err: String(apiErr) }, "quo live: real-time API supplement failed");
    }

    res.json({ active: [...active] });
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

    const fromDate = new Date(from);
    const toDate = new Date(to);

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
