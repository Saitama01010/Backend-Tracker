import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db, phoneCallsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { classifyLine, USER_EMAIL_OVERRIDES, USER_ID_OVERRIDES } from "./quoSync.js";

const router: IRouter = Router();

// ─── Shared live-call state (imported by quo.ts for /api/quo/live) ────────────
export interface LiveCallEntry { agentName: string; participant: string; ringingSince: Date }
export const liveWebhookCalls = new Map<string, LiveCallEntry>();

function purgeExpiredLiveCalls() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [callId, entry] of liveWebhookCalls)
    if (entry.ringingSince.getTime() < cutoff) liveWebhookCalls.delete(callId);
}

const QUO_BASE = "https://api.openphone.com/v1";

function quoKey(): string {
  return process.env["QUO_API_KEY"] ?? "";
}

function webhookSecret(): string {
  return process.env["QUO_WEBHOOK_SECRET"] ?? "";
}

// ─── Signature verification ───────────────────────────────────────────────────
function verifySignature(body: unknown, header: string | undefined): boolean {
  const secret = webhookSecret();
  if (!secret) return process.env.NODE_ENV !== "production";
  if (!header) return false;
  const parts = header.split(";");
  if (parts.length < 4) return false;
  const timestamp = parts[2];
  const provided  = parts[3];
  const signedData = `${timestamp}.${JSON.stringify(body)}`;
  const keyBinary  = Buffer.from(secret, "base64").toString("binary");
  const computed   = crypto
    .createHmac("sha256", keyBinary)
    .update(Buffer.from(signedData, "utf8"))
    .digest("base64");
  const computedBuffer = Buffer.from(computed);
  const providedBuffer = Buffer.from(provided);
  if (computedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(computedBuffer, providedBuffer);
}

// ─── Line info cache (5-min TTL) ─────────────────────────────────────────────
interface LineInfo { id: string; name: string; team: string; }
let lineCache: Map<string, LineInfo> | null = null;
let lineCachedAt = 0;

async function getLineInfo(phoneNumberId: string): Promise<LineInfo | null> {
  const now = Date.now();
  if (!lineCache || now - lineCachedAt > 5 * 60 * 1000) {
    try {
      const res = await fetch(`${QUO_BASE}/phone-numbers`, {
        headers: { Authorization: quoKey() },
      });
      if (res.ok) {
        const json = await res.json() as { data: { id: string; name: string }[] };
        lineCache = new Map();
        for (const l of json.data ?? []) {
          lineCache.set(l.id, { id: l.id, name: l.name, team: classifyLine(l.name) ?? "unknown" });
        }
        lineCachedAt = now;
      }
    } catch (err) {
      logger.warn(err, "quoWebhook: failed to refresh line cache");
    }
  }
  return lineCache?.get(phoneNumberId) ?? null;
}

// ─── User name cache (5-min TTL) ─────────────────────────────────────────────
let userCache: Map<string, string> | null = null;
let userCachedAt = 0;

async function getAgentName(userId: string): Promise<string | null> {
  if (USER_ID_OVERRIDES[userId]) return USER_ID_OVERRIDES[userId] ?? null;
  const now = Date.now();
  if (!userCache || now - userCachedAt > 5 * 60 * 1000) {
    try {
      const res = await fetch(`${QUO_BASE}/users`, {
        headers: { Authorization: quoKey() },
      });
      if (res.ok) {
        const json = await res.json() as {
          data: { id: string; firstName: string; lastName: string; email?: string }[];
        };
        userCache = new Map();
        for (const u of json.data ?? []) {
          const emailKey = u.email?.toLowerCase().trim() ?? "";
          const name = (emailKey && USER_EMAIL_OVERRIDES[emailKey])
            ?? `${u.firstName} ${u.lastName}`.trim();
          userCache.set(u.id, name);
        }
        userCachedAt = now;
      }
    } catch (err) {
      logger.warn(err, "quoWebhook: failed to refresh user cache");
    }
  }
  return userCache?.get(userId) ?? null;
}

// ─── Call object shape from Quo webhook ──────────────────────────────────────
interface WebhookCall {
  id?: string;
  from?: string;
  to?: string;
  direction?: string;
  status?: string;
  createdAt?: string;
  answeredAt?: string | null;
  completedAt?: string | null;
  userId?: string | null;
  phoneNumberId?: string | null;
  answeredBy?: string | null;
  voicemail?: { duration?: number | null } | null;
}

function secondsBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 1000));
}

function classifyWebhookStatus(call: WebhookCall, postAnswerSeconds: number | null): string {
  const rawStatus = call.status ?? "completed";

  if (rawStatus === "completed") {
    if (call.direction === "outgoing") {
      if (postAnswerSeconds !== null) {
        if (postAnswerSeconds >= 60) return "completed";
        if (postAnswerSeconds >= 20) return "voicemail";
        return "voicemail-brief";
      }
      return call.answeredAt ? "completed" : "voicemail-brief";
    }

    if (call.answeredBy || call.answeredAt) return "completed";
    if (call.voicemail) return "voicemail";
    if (postAnswerSeconds !== null && postAnswerSeconds >= 20) return "voicemail";
    return "voicemail-brief";
  }

  if (
    rawStatus === "no-answer" &&
    call.direction === "incoming" &&
    call.completedAt &&
    call.createdAt
  ) {
    const ringSeconds = secondsBetween(call.createdAt, call.completedAt);
    if (ringSeconds !== null && ringSeconds >= 20) return "voicemail";
  }

  return rawStatus;
}

async function handleCallCompleted(obj: Record<string, unknown>) {
  const call = obj as WebhookCall;
  if (!call.id || !call.phoneNumberId) {
    logger.warn({ callId: call.id }, "quoWebhook: missing id or phoneNumberId, skipping");
    return;
  }

  const lineInfo  = await getLineInfo(call.phoneNumberId);
  const lineName  = lineInfo?.name ?? call.phoneNumberId;
  const lineTeam  = lineInfo?.team ?? "unknown";

  const participant = call.direction === "outgoing" ? (call.to ?? "") : (call.from ?? "");

  const postAnswerSeconds = secondsBetween(call.answeredAt, call.completedAt);
  const ringDurationSeconds = secondsBetween(call.createdAt, call.completedAt);
  const durationSeconds = postAnswerSeconds ?? call.voicemail?.duration ?? 0;
  const effectiveStatus = classifyWebhookStatus(call, postAnswerSeconds);

  const agentName = call.userId ? await getAgentName(call.userId) : null;

  await db
    .insert(phoneCallsTable)
    .values({
      id: call.id,
      lineId: call.phoneNumberId,
      lineName,
      lineTeam,
      agentId:   call.userId ?? null,
      agentName,
      participant,
      direction:       call.direction ?? "unknown",
      status:          effectiveStatus,
      durationSeconds,
      postAnswerSeconds,
      ringDurationSeconds,
      createdAt: new Date(call.createdAt ?? Date.now()),
    })
    .onConflictDoUpdate({
      target: phoneCallsTable.id,
      set: {
        lineId: sql`excluded.line_id`,
        lineName: sql`excluded.line_name`,
        lineTeam: sql`excluded.line_team`,
        agentId: sql`excluded.agent_id`,
        agentName: sql`excluded.agent_name`,
        participant: sql`excluded.participant`,
        direction: sql`excluded.direction`,
        status: sql`excluded.status`,
        durationSeconds: sql`excluded.duration_seconds`,
        postAnswerSeconds: sql`excluded.post_answer_seconds`,
        ringDurationSeconds: sql`excluded.ring_duration_seconds`,
        createdAt: sql`excluded.created_at`,
        syncedAt: sql`now()`,
      },
    });

  logger.info(
    { callId: call.id, lineName, lineTeam, agentName, direction: call.direction, status: effectiveStatus, durationSeconds },
    "quoWebhook: upserted call.completed",
  );
}

// ─── POST /api/quo/webhook ────────────────────────────────────────────────────
async function handleOpenPhoneWebhook(req: Request, res: Response) {
  const sig = req.headers["openphone-signature"] as string | undefined;

  if (!verifySignature(req.body, sig)) {
    logger.warn("quoWebhook: signature verification failed");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Always respond 200 immediately so Quo doesn't retry
  res.json({ ok: true });

  const event = req.body as {
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  const type = event?.type ?? "";
  const obj  = event?.data?.object ?? {};

  logger.info({ type }, "quoWebhook: received event");

  purgeExpiredLiveCalls();

  if (type === "call.ringing" || type === "call.answered") {
    // Track live call immediately from webhook — no poll lag
    const call = obj as { id?: string; userId?: string | null; from?: string; to?: string; direction?: string };
    if (call.id && call.userId) {
      const agentName = await getAgentName(call.userId).catch(() => call.userId!);
      const participant = call.direction === "outgoing" ? (call.to ?? "") : (call.from ?? "");
      liveWebhookCalls.set(call.id, { agentName: agentName ?? call.userId!, participant, ringingSince: new Date() });
      logger.info({ callId: call.id, agentName, participant, type }, "quoWebhook: agent now live");
    }
  } else if (type === "call.completed") {
    const call = obj as { id?: string };
    if (call.id) {
      const entry = liveWebhookCalls.get(call.id);
      liveWebhookCalls.delete(call.id);
      if (entry) logger.info({ callId: call.id, agentName: entry.agentName }, "quoWebhook: agent cleared");
    }
    handleCallCompleted(obj).catch((err) => {
      logger.error(err, "quoWebhook: handleCallCompleted error");
    });
  }
  // call.summary.completed, message.*, contact.* — acknowledged, not processed
  return;
}

router.post("/quo/webhook", handleOpenPhoneWebhook);
router.post("/openphone/webhook", handleOpenPhoneWebhook);

export default router;
