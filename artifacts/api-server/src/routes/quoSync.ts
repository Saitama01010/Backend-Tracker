import { db, phoneCallsTable, phoneSyncStateTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const QUO_KEY = process.env.QUO_API_KEY ?? "";
const BASE = "https://api.openphone.com/v1";

async function quoFetch<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, { headers: { Authorization: QUO_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenPhone ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function classifyLine(name: string): "retention" | "nsf" | "cs" | null {
  const n = name.toLowerCase().trim();
  if (/retention|ob|outbound|maison|tax|jacob|levi|ryan|mike|adam|rick|zeiad|zack/.test(n)) return "retention";
  if (/nsf|national settlement|ellie|alex|katie|jenny|estella|talia|rika|austin/.test(n)) return "nsf";
  if (/\bcs\b|customer support/.test(n) || name === "CS Team") return "cs";
  return null;
}

const LINE_AGENT_OVERRIDES: Record<string, string> = {
  // Line name (lowercase) → display name for every call on that line
  "adam ob": "Abdulrhman Isawi",
  "jacob ob": "Youssef Nady",
  "levi ob": "Ahmed Ayman",
  "rick ob": "Zeiad Fouad",
  "ryan ob": "Ryan Henderson",
  // Legacy / alternate line name formats
  "abdlrhman-jacob stephenson": "Abdulrhman Isawi",
  "youssef nady-jacob xander": "Youssef Nady",
  "ahmed ayman-levi miller": "Ahmed Ayman",
  "zeiad fouad-zack ford": "Zeiad Fouad",
  "nour-michael belfort-2900": "Michael Belfort",
  "mohammed ayman-max francis-2268": "Max Francis",
};

// Email → canonical display name (used for shared lines like CS Team where
// each agent uses their own OpenPhone user account)
const USER_EMAIL_OVERRIDES: Record<string, string> = {
  // CS Team
  "noura.asahab@gmail.com": "Nora Adam",
  "basantemadeldin@yahoo.com": "Carla Bennet",
  "carla.bennet212@gmail.com": "Carla Bennet",
  "basantemadeldin@gmail.com": "Carla Bennet",
  "leocarter032@gmail.com": "Leo Carter",
  // Retention (covers shared/multi-assigned lines)
  "abdulrhmanisawi61@gmail.com": "Abdulrhman Isawi",
  "usave1792001@gmail.com": "Youssef Nady",
  "leviimiller178@gmail.com": "Ahmed Ayman",
  "muhamedwalid053@gmail.com": "Ryan Henderson",
  "zeiad.shebo@yahoo.com": "Zeiad Fouad",
  "nouralden.abdel0@gmail.com": "Michael Belfort",
  "mohammed.mdidnd2001@gmail.com": "Max Francis",
  // NSF
  "alii.kamal.othman@gmail.com": "Alex Cruz",
  "lucaash220@gmail.com": "Austin White",
  "riham.samir.web@gmail.com": "Rika Hart",
  "hiitisahd@gmail.com": "Jenny Morgan",
  "emankhamisz58@gmail.com": "Estella Cruz",
  "toqahossam548@gmail.com": "Talia Morgan",
  "samafarouk90@gmail.com": "Katie Miller",
  "ingimahmoud01@gmail.com": "Ellie Moser",
};

interface PhoneNumber {
  id: string;
  name: string;
  users?: { id: string; firstName: string; lastName: string; email?: string }[];
}

interface Call {
  id: string;
  direction: string;
  status: string;
  duration: number;
  createdAt: string;
  userId?: string;
  from?: string;
  to?: string;
}

async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try {
        results[idx] = await tasks[idx]();
      } catch {
        results[idx] = undefined as unknown as T;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Fetch every call on a phone number line in a date range — no participant filter, matching OpenPhone analytics exactly. */
async function fetchAllCallsForLine(
  phoneNumberId: string,
  createdAfter: string,
  createdBefore: string,
): Promise<Call[]> {
  const all: Call[] = [];
  let pageToken: string | null = null;
  let page = 0;
  do {
    let url =
      `/calls?phoneNumberId=${encodeURIComponent(phoneNumberId)}` +
      `&createdAfter=${encodeURIComponent(createdAfter)}` +
      `&createdBefore=${encodeURIComponent(createdBefore)}` +
      `&maxResults=100`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await quoFetch<{ data: Call[]; nextPageToken?: string | null }>(url);
    const chunk = res.data ?? [];
    all.push(...chunk);
    pageToken = res.nextPageToken ?? null;
    page++;
    if (page > 50) break; // safety cap
    if (chunk.length < 100) break; // last page
  } while (pageToken);
  return all;
}

export async function runSync(fromDate: Date, toDate: Date): Promise<{ inserted: number; errors: number }> {
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  logger.info({ from, to }, "quoSync: starting sync");

  const linesRes = await quoFetch<{ data: PhoneNumber[] }>("/phone-numbers");
  const lines = (linesRes.data ?? []).filter((p) => classifyLine(p.name) !== null);

  const userMap = new Map<string, string>();
  for (const line of lines) {
    for (const u of line.users ?? []) {
      if (!userMap.has(u.id)) {
        const emailKey = u.email?.toLowerCase().trim() ?? "";
        const displayName =
          (emailKey && USER_EMAIL_OVERRIDES[emailKey]) ??
          `${u.firstName} ${u.lastName}`.trim();
        userMap.set(u.id, displayName);
      }
    }
  }
  logger.info({ lineCount: lines.length, userCount: userMap.size }, "quoSync: got lines");

  const callResults = await withConcurrency(
    lines.map((line) => async () => {
      const calls = await fetchAllCallsForLine(line.id, from, to).catch(() => [] as Call[]);
      return { line, calls };
    }),
    6,
  );

  logger.info({ lineCount: lines.length }, "quoSync: calls fetched, writing to DB");

  let inserted = 0;
  let errors = 0;
  const rows: (typeof phoneCallsTable.$inferInsert)[] = [];

  for (const result of callResults) {
    if (!result) continue;
    const { line, calls } = result;
    const team = classifyLine(line.name)!;
    const overrideName = LINE_AGENT_OVERRIDES[line.name.toLowerCase().trim()];

    for (const call of calls) {
      const agentName = overrideName ?? (call.userId ? (userMap.get(call.userId) ?? call.userId) : null);
      const participant = call.direction === "outgoing" ? (call.to ?? "") : (call.from ?? "");
      rows.push({
        id: call.id,
        lineId: line.id,
        lineName: line.name,
        lineTeam: team,
        agentId: call.userId ?? null,
        agentName,
        participant,
        direction: call.direction,
        status: call.status,
        durationSeconds: call.duration ?? 0,
        createdAt: new Date(call.createdAt),
      });
    }
  }

  if (rows.length > 0) {
    try {
      await db
        .insert(phoneCallsTable)
        .values(rows)
        .onConflictDoUpdate({
          target: phoneCallsTable.id,
          set: {
            lineTeam: sql`excluded.line_team`,
            agentId: sql`excluded.agent_id`,
            agentName: sql`excluded.agent_name`,
            status: sql`excluded.status`,
            durationSeconds: sql`excluded.duration_seconds`,
            syncedAt: sql`now()`,
          },
        });
      inserted = rows.length;
    } catch (err) {
      logger.error(err, "quoSync: DB write error");
      errors++;
    }
  }

  await db
    .insert(phoneSyncStateTable)
    .values({ id: "singleton", lastSyncedAt: new Date(), isSyncing: false })
    .onConflictDoUpdate({
      target: phoneSyncStateTable.id,
      set: { lastSyncedAt: new Date(), isSyncing: false, lastError: null, updatedAt: new Date() },
    });

  logger.info({ inserted, errors }, "quoSync: done");
  return { inserted, errors };
}

let syncRunning = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export async function startBackgroundSync() {
  if (syncRunning) return;
  syncRunning = true;

  const doSync = async () => {
    try {
      const now = new Date();
      const state = await getSyncState();
      if (state?.lastSyncedAt) {
        const msSinceLast = now.getTime() - state.lastSyncedAt.getTime();
        const overlapMs = Math.max(msSinceLast + 10 * 60 * 1000, 2 * 60 * 60 * 1000);
        const from = new Date(now.getTime() - overlapMs);
        logger.info({ windowHours: overlapMs / 3600000 }, "quoSync: incremental sync");
        await runSync(from, now);
      } else {
        const from = new Date(now.getTime() - 4 * 60 * 60 * 1000);
        logger.info("quoSync: initial 4h sync");
        await runSync(from, now);
      }
    } catch (err) {
      logger.error(err, "quoSync: background sync error");
    } finally {
      syncTimer = setTimeout(doSync, 15 * 60 * 1000);
    }
  };

  doSync();
}

export async function getSyncState() {
  const rows = await db.select().from(phoneSyncStateTable).limit(1);
  return rows[0] ?? null;
}
