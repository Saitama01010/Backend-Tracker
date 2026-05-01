import { Router, type IRouter } from "express";
import { db, phoneCallsTable } from "@workspace/db";
import { and, gte, lte } from "drizzle-orm";
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

function classifyLine(name: string): "retention" | "nsf" | "cs" | null {
  const n = name.toLowerCase().trim();
  if (/retention|ob|outbound|maison|tax|jacob|levi|ryan|mike|adam|rick|zeiad|zack/.test(n)) return "retention";
  if (/nsf|national settlement|ellie|alex|katie|jenny|estella|talia|rika|austin/.test(n)) return "nsf";
  if (/\bcs\b|customer support/.test(n) || name === "CS Team") return "cs";
  return null;
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
      .where(and(gte(phoneCallsTable.createdAt, fromDate), lte(phoneCallsTable.createdAt, toDate)));

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
      const team = row.lineTeam;
      const agentName = row.agentName ?? "Unknown";
      const date = row.createdAt.toISOString().slice(0, 10);

      if (!teamStats[team]) teamStats[team] = {};
      if (!teamStats[team][agentName]) teamStats[team][agentName] = {};
      if (!teamStats[team][agentName][date]) {
        teamStats[team][agentName][date] = {
          outbound: 0, inbound: 0, answered: 0, missed: 0,
          voicemail: 0, totalCalls: 0, talkSeconds: 0, uniqueContacts: new Set(),
        };
      }
      const slot = teamStats[team][agentName][date];
      slot.totalCalls++;
      slot.talkSeconds += row.durationSeconds;
      slot.uniqueContacts.add(row.participant);
      if (!agentLastCall[team]) agentLastCall[team] = {};
      if (!agentLastCall[team][agentName] || row.createdAt > agentLastCall[team][agentName]) {
        agentLastCall[team][agentName] = row.createdAt;
      }
      if (row.direction === "outgoing") slot.outbound++;
      else slot.inbound++;
      if (row.status === "completed") slot.answered++;
      else if (row.status === "voicemail") slot.voicemail++;
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

startBackgroundSync();

export { router as quoRouter };
export default router;
