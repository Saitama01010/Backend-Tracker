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

// Exact line name → team overrides (takes priority over regex, handles moved agents)
const LINE_TEAM_MAP: Record<string, "retention" | "nsf" | "cs"> = {
  "ahmed ayman-levi miller":         "retention", // Ahmed Ayman → Retention
  "youssef nady-jacob xander":       "cs",
  "nour-michael belfort-2900":       "retention", // Michael Belfort → Retention
  "levi ob":                         "retention", // Ahmed Ayman → Retention
  "levi cs ob":                      "retention", // Ahmed Ayman → Retention
  "talia nsf":                       "retention", // Talia Morgan → Retention
  "talia morgan cs ob":              "retention", // Talia Morgan → Retention
  "jacob ob":                        "cs",        // Youssef Nady → CS
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
  // Exact overrides first (agents who moved teams)
  if (n in LINE_TEAM_MAP) return LINE_TEAM_MAP[n];
  // CS — check before retention because some names overlap
  if (/\bcs\b|customer support|talia|hiba|nourhan|rasha|bassant|ella monroe/.test(n) || name === "CS Team") return "cs";
  if (/retention|ob|outbound|ryan|abdlrhman|rick|zeiad|zack|henry.?hart|chase.?miller|katherine|karma|leo.?carter|fares/.test(n)) return "retention";
  if (/nsf|national settlement|ellie|alex|katie|jenny|estella|rika|austin/.test(n)) return "nsf";
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

// Former employees no longer in the workspace — map by user ID directly
export const USER_ID_OVERRIDES: Record<string, string> = {
  USahWqOQpm: "Unknown Agent",
  US3fJL9dBL: "Unknown Agent",
  USRAl7CoAq: "Unknown Agent",
};

export const USER_EMAIL_OVERRIDES: Record<string, string> = {
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
  // New members from May 2026 roster update
  "hiba.kamil.r@gmail.com":   "Ella Monroe",    // CS
  "saifaziz.598@gmail.com":   "Henry Hart",     // Retention
  "natef737@gmail.com":       "Chase Miller",   // Retention
  "karmaafarouk@gmail.com":   "Katherine Adams", // Retention
  // Resolved via /users endpoint
  "ahmedatta9696@gmail.com": "Elias Boone",
  "crazyanas36@gmail.com": "Kyle Scott",
  "mohamedgh773@gmail.com": "Leo Maxwell",
  "mike_j27@aol.com": "Mike Johnson",
  "baseersalaheldin1001@gmail.com": "Baser Salah",
  "anasmohamedaly2006@gmail.com": "Anas Mohamed",
  "faridasalah808@gmail.com": "Freya Kallias",
  "ghadavxz@gmail.com": "Jade Atwood",
  "zwingherr2506@gmail.com": "Andrew Gomez",
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
  completedAt?: string | null;
  answeredAt?: string | null;
  userId?: string;
  participants?: string[];
  answeredBy?: string | null;
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
  const lines = allLines; // sync ALL lines, not just classified ones
  const lineMap = new Map(lines.map((l) => [l.id, l]));
  const knownLineIds = new Set(lines.map((l) => l.id));

  // Build userMap: merge /users endpoint + line.users so no agent is missed
  const userMap = new Map<string, string>();

  function addUser(u: { id: string; firstName: string; lastName: string; email?: string }) {
    if (userMap.has(u.id)) return;
    const emailKey = u.email?.toLowerCase().trim() ?? "";
    const displayName =
      (emailKey && USER_EMAIL_OVERRIDES[emailKey]) ??
      `${u.firstName} ${u.lastName}`.trim();
    userMap.set(u.id, displayName);
  }

  // Primary: /users endpoint
  try {
    const usersRes = await quoFetch<{
      data: { id: string; firstName: string; lastName: string; email?: string }[];
    }>("/users");
    for (const u of usersRes.data ?? []) addUser(u);
  } catch (err) {
    logger.warn(err, "quoSync: /users endpoint failed, falling back to line users only");
  }

  // Always also pull from line.users to catch agents not returned by /users
  for (const line of allLines) {
    for (const u of line.users ?? []) addUser(u);
  }
  // Build map of internal (org-owned) phone number → line name.
  // Internal calls (one org line calling another) are kept but stored with the line name
  // as the participant so it's clear this was an internal transfer, not an external customer.
  const internalNumberToName = new Map<string, string>();
  for (const l of allLines) {
    if (l.number) internalNumberToName.set(l.number, l.name);
  }
  logger.info({ lineCount: lines.length, userCount: userMap.size, internalLines: internalNumberToName.size }, "quoSync: got lines");

  // Step 1: collect all (lineId → participants) from conversations
  const byLine = await fetchConversationsByLine(from, to, knownLineIds);
  const totalParticipants = [...byLine.values()].reduce((s, v) => s + v.size, 0);
  logger.info(
    { linesWithConversations: byLine.size, totalParticipants },
    "quoSync: conversations fetched, fetching calls",
  );

  // Step 2: build flat task list of (lineId, participant) pairs
  // Internal participants (org lines) are kept but their number is replaced with the line name
  // so they appear as e.g. "Leo Carter CS OB" instead of a raw phone number.
  const tasks: { lineId: string; participant: string; displayParticipant: string }[] = [];
  for (const [lineId, participants] of byLine) {
    for (const participant of participants) {
      const internalName = internalNumberToName.get(participant);
      tasks.push({ lineId, participant, displayParticipant: internalName ?? participant });
    }
  }

  // Step 3: fetch calls concurrently (limit=5 to avoid rate limits)
  let tasksDone = 0;
  const callsByTask = await withConcurrency(
    tasks.map(({ lineId, participant, displayParticipant }) => async () => {
      const calls = await fetchCallsForParticipant(lineId, participant, from, to).catch((err) => {
        logger.error({ lineId, participant, err: String(err) }, "quoSync: call fetch error");
        return [] as Call[];
      });
      tasksDone++;
      if (tasksDone % 100 === 0) {
        logger.info({ tasksDone, total: tasks.length }, "quoSync: call fetch progress");
      }
      // displayParticipant: for internal calls this is the line name; for external it's the phone number
      return { lineId, participant: displayParticipant, calls };
    }),
    5,
  );

  logger.info({ lineCount: lines.length }, "quoSync: calls fetched, writing to DB");

  const rows: (typeof phoneCallsTable.$inferInsert)[] = [];
  const seenCallIds = new Set<string>();

  for (const result of callsByTask) {
    if (!result) continue;
    const { lineId, participant: taskParticipant, calls } = result;
    const line = lineMap.get(lineId);
    if (!line) continue;
    const team = classifyLine(line.name) ?? "other";
    const overrideName = LINE_AGENT_OVERRIDES[line.name.toLowerCase().trim()];

    for (const call of calls) {
      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);

      // For INBOUND calls, answeredBy is the agent who actually picked up the phone.
      // userId on an inbound call is the line owner/primary number holder — NOT the answerer.
      // For OUTBOUND calls, userId is the agent who dialled; answeredBy is always null.
      const effectiveUserId =
        call.direction === "incoming" && call.answeredBy
          ? call.answeredBy
          : call.userId;

      const agentName =
        overrideName ??
        (effectiveUserId
          ? (userMap.get(effectiveUserId) ??
             USER_ID_OVERRIDES[effectiveUserId] ??
             effectiveUserId)
          : null);

      // Use the participant from the conversation query (the customer's number).
      // call.participants[0] is the line's own number, NOT the customer.
      const participant = taskParticipant || null;

      // Compute post-answer seconds: time spent in the VM system after it picks up.
      // Used to distinguish "left a voicemail message" vs "hung up on voicemail greeting".
      let postAnswerSeconds: number | null = null;
      if (call.answeredAt && call.completedAt) {
        postAnswerSeconds = Math.round(
          (new Date(call.completedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000,
        );
      }

      // OpenPhone's answeredBy is ONLY set for inbound calls (which agent picked up).
      // For outbound calls answeredBy is always null even when the customer answers.
      // Strategy:
      //   INBOUND: answeredBy != null → "completed"; answeredBy==null → voicemail/brief
      //   OUTBOUND: postAnswerSeconds >= 60 → real conversation ("completed");
      //             20–59s → likely left a voicemail message ("voicemail");
      //             <20s   → hung up on VM without leaving a message ("voicemail-brief")
      let effectiveStatus = call.status;
      if (call.status === "completed" && call.answeredBy == null) {
        if (call.direction === "outgoing") {
          if (postAnswerSeconds !== null && postAnswerSeconds >= 60) {
            effectiveStatus = "completed"; // customer answered, real conversation
          } else if (postAnswerSeconds !== null && postAnswerSeconds >= 20) {
            effectiveStatus = "voicemail"; // left a voicemail message
          } else {
            effectiveStatus = "voicemail-brief"; // hung up on VM
          }
        } else {
          // Inbound: answeredBy==null means agent's voicemail picked up
          if (postAnswerSeconds !== null && postAnswerSeconds >= 20) {
            effectiveStatus = "voicemail";
          } else {
            effectiveStatus = "voicemail-brief";
          }
        }
      }

      rows.push({
        id: call.id,
        lineId: line.id,
        lineName: line.name,
        lineTeam: team,
        agentId: effectiveUserId ?? null,
        agentName,
        participant,
        direction: call.direction,
        status: effectiveStatus,
        durationSeconds: call.duration ?? 0,
        postAnswerSeconds,
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
              participant: sql`excluded.participant`,
              status: sql`excluded.status`,
              durationSeconds: sql`excluded.duration_seconds`,
              postAnswerSeconds: sql`excluded.post_answer_seconds`,
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

  // If the DB has very few calls (fresh or incomplete deployment), wipe the sync
  // state so the full 90-day backfill runs on the next cycle.
  try {
    const countRow = await db.select({ count: sql<number>`count(*)::int` }).from(phoneCallsTable);
    const totalCalls = countRow[0]?.count ?? 0;
    if (totalCalls < 500) {
      await db.delete(phoneSyncStateTable);
      logger.info({ totalCalls }, "quoSync: sparse DB detected — reset sync state for full backfill");
    }
  } catch (err) {
    logger.error(err, "quoSync: startup call-count check failed");
  }

  // On every deploy/restart, run a 2-day backfill in the background so that
  // today's and yesterday's calls are always correctly attributed — regardless
  // of what the incremental window covered before the deploy.
  const startupBackfillFrom = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  logger.info({ from: startupBackfillFrom }, "quoSync: startup 2-day backfill");
  runSync(startupBackfillFrom, new Date()).catch((err) => {
    logger.error(err, "quoSync: startup backfill error");
  });

  const doSync = async () => {
    try {
      const now = new Date();
      const state = await getSyncState();
      if (state?.lastSyncedAt) {
        const msSinceLast = now.getTime() - state.lastSyncedAt.getTime();
        const overlapMs = Math.max(msSinceLast + 2 * 60 * 1000, 30 * 60 * 1000);
        const from = new Date(now.getTime() - overlapMs);
        logger.info({ windowHours: overlapMs / 3600000 }, "quoSync: incremental sync");
        await runSync(from, now);
      } else {
        // First startup — backfill 90 days of history
        const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        logger.info("quoSync: initial 90-day backfill");
        await runSync(from, now);
      }
    } catch (err) {
      logger.error(err, "quoSync: background sync error");
    } finally {
      syncTimer = setTimeout(doSync, 15 * 60 * 1000); // 15 minutes
    }
  };

  doSync();
}

export async function getSyncState() {
  const rows = await db.select().from(phoneSyncStateTable).limit(1);
  return rows[0] ?? null;
}
