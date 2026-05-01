import { db, phoneCallsTable, phoneSyncStateTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const QUO_KEY = process.env.QUO_API_KEY ?? "";
const BASE = "https://api.openphone.com/v1";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function quoFetch<T>(path: string, attempt = 0): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, { headers: { Authorization: QUO_KEY } });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 5);
    const wait = Math.max(retryAfter * 1000, 5000) * (attempt + 1);
    logger.warn({ attempt, wait }, "quoFetch: rate limited, retrying");
    await sleep(wait);
    return quoFetch<T>(path, attempt + 1);
  }
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
  "adam ob": "Abdulrhman Isawi",
  "jacob ob": "Youssef Nady",
  "levi ob": "Ahmed Ayman",
  "rick ob": "Zeiad Fouad",
  "ryan ob": "Ryan Henderson",
  "abdlrhman-jacob stephenson": "Abdulrhman Isawi",
  "youssef nady-jacob xander": "Youssef Nady",
  "ahmed ayman-levi miller": "Ahmed Ayman",
  "zeiad fouad-zack ford": "Zeiad Fouad",
  "nour-michael belfort-2900": "Michael Belfort",
  "mohammed ayman-max francis-2268": "Max Francis",
};

const USER_EMAIL_OVERRIDES: Record<string, string> = {
  "noura.asahab@gmail.com": "Nora Adam",
  "basantemadeldin@yahoo.com": "Carla Bennet",
  "carla.bennet212@gmail.com": "Carla Bennet",
  "basantemadeldin@gmail.com": "Carla Bennet",
  "leocarter032@gmail.com": "Leo Carter",
  "abdulrhmanisawi61@gmail.com": "Abdulrhman Isawi",
  "usave1792001@gmail.com": "Youssef Nady",
  "leviimiller178@gmail.com": "Ahmed Ayman",
  "muhamedwalid053@gmail.com": "Ryan Henderson",
  "zeiad.shebo@yahoo.com": "Zeiad Fouad",
  "nouralden.abdel0@gmail.com": "Michael Belfort",
  "mohammed.mdidnd2001@gmail.com": "Max Francis",
  "alii.kamal.othman@gmail.com": "Alex Cruz",
  "lucaash220@gmail.com": "Austin White",
  "riham.samir.web@gmail.com": "Rika Hart",
  "hiitisahd@gmail.com": "Jenny Morgan",
  "emankhamisz58@gmail.com": "Estella Cruz",
  "toqahossam548@gmail.com": "Talia Morgan",
  "samafarouk90@gmail.com": "Katie Miller",
  "ingimahmoud01@gmail.com": "Ellie Moser",
  // Resolved via /users endpoint
  "ahmedatta9696@gmail.com": "Elias Boone",
  "crazyanas36@gmail.com": "Kyle Scott",
  "mohamedgh773@gmail.com": "Leo Maxwell",
  "mike_j27@aol.com": "Mike Johnson",
  "baseersalaheldin1001@gmail.com": "Baser Salah",
  "anasmohamedaly2006@gmail.com": "Anas Mohamed",
};

interface PhoneNumber {
  id: string;
  name: string;
  number?: string;
  users?: { id: string; firstName: string; lastName: string; email?: string }[];
}

interface Conversation {
  id: string;
  phoneNumberId: string;
  participants: string[];
}

interface Call {
  id: string;
  direction: string;
  status: string;
  duration: number;
  createdAt: string;
  userId?: string;
  participants?: string[];
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

/**
 * Step 1: Page through ALL workspace conversations for the date range.
 * Group by phoneNumberId to get each line's unique external participants.
 * NOTE: The API ignores phoneNumberId filter on conversations, so we must
 * fetch everything and group by the conversation's own phoneNumberId.
 */
async function fetchConversationsByLine(
  from: string,
  to: string,
  knownLineIds: Set<string>,
): Promise<Map<string, Set<string>>> {
  const byLine = new Map<string, Set<string>>();
  let pageToken: string | null = null;
  let page = 0;

  do {
    // Use updatedAfter/updatedBefore so conversations with recent activity
    // (even if created before the window) are included.
    let url =
      `/conversations?updatedAfter=${encodeURIComponent(from)}` +
      `&updatedBefore=${encodeURIComponent(to)}` +
      `&maxResults=100`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const res = await quoFetch<{ data: Conversation[]; nextPageToken?: string | null }>(url);
    const chunk = res.data ?? [];

    for (const conv of chunk) {
      const lineId = conv.phoneNumberId;
      if (!lineId || !knownLineIds.has(lineId)) continue;
      if (!byLine.has(lineId)) byLine.set(lineId, new Set());
      for (const p of conv.participants ?? []) {
        if (p) byLine.get(lineId)!.add(p);
      }
    }

    pageToken = res.nextPageToken ?? null;
    page++;

    if (page % 10 === 0) {
      const totalParticipants = [...byLine.values()].reduce((s, v) => s + v.size, 0);
      logger.info({ page, totalParticipants }, "quoSync: paging conversations");
    }
    if (page > 1000) {
      logger.warn({ page }, "quoSync: hit conversation page cap");
      break;
    }
    if (page % 5 === 0) await sleep(200);
  } while (pageToken);

  return byLine;
}

/**
 * Step 2: Fetch all calls for a specific (lineId, participant) pair in the date range.
 * The API requires exactly one participant[] value per request.
 */
async function fetchCallsForParticipant(
  lineId: string,
  participant: string,
  from: string,
  to: string,
): Promise<Call[]> {
  const all: Call[] = [];
  let pageToken: string | null = null;
  let page = 0;

  do {
    let url =
      `/calls?phoneNumberId=${encodeURIComponent(lineId)}` +
      `&participants[]=${encodeURIComponent(participant)}` +
      `&createdAfter=${encodeURIComponent(from)}` +
      `&createdBefore=${encodeURIComponent(to)}` +
      `&maxResults=100`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const res = await quoFetch<{ data: Call[]; nextPageToken?: string | null }>(url);
    const chunk = res.data ?? [];
    all.push(...chunk);
    pageToken = res.nextPageToken ?? null;
    page++;
    if (page > 50) break;
    if (page % 5 === 0) await sleep(100);
  } while (pageToken);

  return all;
}

export async function runSync(fromDate: Date, toDate: Date): Promise<{ inserted: number; errors: number }> {
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  logger.info({ from, to }, "quoSync: starting sync");

  const linesRes = await quoFetch<{ data: PhoneNumber[] }>("/phone-numbers");
  const allLines = linesRes.data ?? [];
  const lines = allLines.filter((p) => classifyLine(p.name) !== null);
  const lineMap = new Map(lines.map((l) => [l.id, l]));
  const knownLineIds = new Set(lines.map((l) => l.id));

  // Build userMap from /users endpoint (covers all workspace users,
  // not just those listed on classified lines)
  const userMap = new Map<string, string>();
  try {
    const usersRes = await quoFetch<{
      data: { id: string; firstName: string; lastName: string; email?: string }[];
    }>("/users");
    for (const u of usersRes.data ?? []) {
      const emailKey = u.email?.toLowerCase().trim() ?? "";
      const displayName =
        (emailKey && USER_EMAIL_OVERRIDES[emailKey]) ??
        `${u.firstName} ${u.lastName}`.trim();
      userMap.set(u.id, displayName);
    }
  } catch {
    // Fallback: build from line users if /users endpoint fails
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
  }
  logger.info({ lineCount: lines.length, userCount: userMap.size }, "quoSync: got lines");

  // Step 1: collect all (lineId → participants) from conversations
  const byLine = await fetchConversationsByLine(from, to, knownLineIds);
  const totalParticipants = [...byLine.values()].reduce((s, v) => s + v.size, 0);
  logger.info(
    { linesWithConversations: byLine.size, totalParticipants },
    "quoSync: conversations fetched, fetching calls",
  );

  // Step 2: build flat task list of (lineId, participant) pairs
  const tasks: { lineId: string; participant: string }[] = [];
  for (const [lineId, participants] of byLine) {
    for (const participant of participants) {
      tasks.push({ lineId, participant });
    }
  }

  // Step 3: fetch calls concurrently (limit=5 to avoid rate limits)
  let tasksDone = 0;
  const callsByTask = await withConcurrency(
    tasks.map(({ lineId, participant }) => async () => {
      const calls = await fetchCallsForParticipant(lineId, participant, from, to).catch((err) => {
        logger.error({ lineId, participant, err: String(err) }, "quoSync: call fetch error");
        return [] as Call[];
      });
      tasksDone++;
      if (tasksDone % 100 === 0) {
        logger.info({ tasksDone, total: tasks.length }, "quoSync: call fetch progress");
      }
      return { lineId, calls };
    }),
    5,
  );

  logger.info({ lineCount: lines.length }, "quoSync: calls fetched, writing to DB");

  const rows: (typeof phoneCallsTable.$inferInsert)[] = [];
  const seenCallIds = new Set<string>();

  for (const result of callsByTask) {
    if (!result) continue;
    const { lineId, calls } = result;
    const line = lineMap.get(lineId);
    if (!line) continue;
    const team = classifyLine(line.name)!;
    const overrideName = LINE_AGENT_OVERRIDES[line.name.toLowerCase().trim()];

    for (const call of calls) {
      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);

      const agentName = overrideName ?? (call.userId ? (userMap.get(call.userId) ?? call.userId) : null);
      const participant = call.participants?.[0] ?? "";
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

  let inserted = 0;
  let errors = 0;

  if (rows.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      try {
        await db
          .insert(phoneCallsTable)
          .values(rows.slice(i, i + CHUNK))
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
        inserted += Math.min(CHUNK, rows.length - i);
      } catch (err) {
        logger.error(err, "quoSync: DB write error");
        errors++;
      }
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
