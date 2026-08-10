import { Router, type IRouter, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db, phoneCallsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  processDurableWebhook,
  sanitizedWebhookErrorCode,
  type WebhookTerminalStatus,
} from "../lib/durableWebhook.js";
import {
  parseOpenPhoneWebhook,
  verifyOpenPhoneSignature,
  webhookTimestampToleranceSeconds,
  type VerifiedWebhookEvent,
} from "../lib/openPhoneWebhook.js";
import { hasProcessedCallCompletion, openPhoneWebhookInbox } from "../lib/webhookInboxStore.js";
import { classifyLine, USER_EMAIL_OVERRIDES, USER_ID_OVERRIDES } from "./quoSync.js";

const router: IRouter = Router();

export interface LiveCallEntry {
  agentName: string;
  participant: string;
  ringingSince: Date;
}

// This map remains a low-latency view only. Durable event receipt and completed
// call persistence are database-backed, and /api/quo/live retains its existing
// provider polling/database fallback behavior.
export const liveWebhookCalls = new Map<string, LiveCallEntry>();

function purgeExpiredLiveCalls() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [callId, entry] of liveWebhookCalls) {
    if (entry.ringingSince.getTime() < cutoff) liveWebhookCalls.delete(callId);
  }
}

const QUO_BASE = "https://api.openphone.com/v1";

function quoKey(): string {
  return process.env["QUO_API_KEY"] ?? "";
}

function webhookSecret(): string {
  return process.env["QUO_WEBHOOK_SECRET"] ?? "";
}

interface LineInfo {
  id: string;
  name: string;
  team: string;
}

let lineCache: Map<string, LineInfo> | null = null;
let lineCachedAt = 0;

async function getLineInfo(phoneNumberId: string): Promise<LineInfo | null> {
  if (!quoKey()) return lineCache?.get(phoneNumberId) ?? null;
  const now = Date.now();
  if (!lineCache || now - lineCachedAt > 5 * 60 * 1000) {
    try {
      const res = await fetch(`${QUO_BASE}/phone-numbers`, {
        headers: { Authorization: quoKey() },
      });
      if (res.ok) {
        const json = await res.json() as { data: { id: string; name: string }[] };
        lineCache = new Map();
        for (const line of json.data ?? []) {
          lineCache.set(line.id, {
            id: line.id,
            name: line.name,
            team: classifyLine(line.name) ?? "unknown",
          });
        }
        lineCachedAt = now;
      }
    } catch {
      logger.warn("quoWebhook: failed to refresh line cache");
    }
  }
  return lineCache?.get(phoneNumberId) ?? null;
}

let userCache: Map<string, string> | null = null;
let userCachedAt = 0;

async function getAgentName(userId: string): Promise<string | null> {
  if (USER_ID_OVERRIDES[userId]) return USER_ID_OVERRIDES[userId] ?? null;
  if (!quoKey()) return userCache?.get(userId) ?? null;
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
        for (const user of json.data ?? []) {
          const emailKey = user.email?.toLowerCase().trim() ?? "";
          const name = (emailKey && USER_EMAIL_OVERRIDES[emailKey])
            ?? `${user.firstName} ${user.lastName}`.trim();
          userCache.set(user.id, name);
        }
        userCachedAt = now;
      }
    } catch {
      logger.warn("quoWebhook: failed to refresh user cache");
    }
  }
  return userCache?.get(userId) ?? null;
}

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

// Keep the pre-hardening status interpretation and KPI thresholds unchanged.
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

  const [lineInfo, agentName] = await Promise.all([
    getLineInfo(call.phoneNumberId),
    call.userId ? getAgentName(call.userId) : Promise.resolve(null),
  ]);
  const lineName = lineInfo?.name ?? call.phoneNumberId;
  const lineTeam = lineInfo?.team ?? "unknown";
  const participant = call.direction === "outgoing" ? (call.to ?? "") : (call.from ?? "");
  const postAnswerSeconds = secondsBetween(call.answeredAt, call.completedAt);
  const ringDurationSeconds = secondsBetween(call.createdAt, call.completedAt);
  const durationSeconds = postAnswerSeconds ?? call.voicemail?.duration ?? 0;
  const effectiveStatus = classifyWebhookStatus(call, postAnswerSeconds);

  await db
    .insert(phoneCallsTable)
    .values({
      id: call.id,
      lineId: call.phoneNumberId,
      lineName,
      lineTeam,
      agentId: call.userId ?? null,
      agentName,
      participant,
      direction: call.direction ?? "unknown",
      status: effectiveStatus,
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
    { callId: call.id, eventType: "call.completed", status: effectiveStatus, durationSeconds },
    "quoWebhook: upserted call.completed",
  );
}

async function processOpenPhoneEvent(delivery: VerifiedWebhookEvent): Promise<WebhookTerminalStatus> {
  const type = delivery.eventType;
  const obj = delivery.event.data?.object ?? {};

  logger.info(
    { providerEventId: delivery.providerEventId, eventType: type },
    "quoWebhook: processing event",
  );
  purgeExpiredLiveCalls();

  if (type === "call.ringing" || type === "call.answered") {
    const call = obj as {
      id?: string;
      userId?: string | null;
      from?: string;
      to?: string;
      direction?: string;
    };
    if (call.id && call.userId) {
      // A delayed ringing/answered delivery must not resurrect a call that has
      // already completed. The completion check is durable across processes.
      if (await hasProcessedCallCompletion(call.id)) {
        logger.info(
          { providerEventId: delivery.providerEventId, eventType: type, callId: call.id },
          "quoWebhook: ignored late live-call event",
        );
        return "processed";
      }
      const agentName = await getAgentName(call.userId).catch(() => call.userId!);
      const participant = call.direction === "outgoing" ? (call.to ?? "") : (call.from ?? "");
      liveWebhookCalls.set(call.id, {
        agentName: agentName ?? call.userId,
        participant,
        ringingSince: new Date(),
      });
      logger.info(
        { providerEventId: delivery.providerEventId, eventType: type, callId: call.id },
        "quoWebhook: agent now live",
      );
    }
    return "processed";
  }

  if (type === "call.completed") {
    const call = obj as { id?: string };
    if (call.id) {
      liveWebhookCalls.delete(call.id);
      logger.info(
        { providerEventId: delivery.providerEventId, eventType: type, callId: call.id },
        "quoWebhook: agent cleared",
      );
    }
    await handleCallCompleted(obj);
    return "processed";
  }

  // Existing behavior acknowledges other configured events without applying
  // them to dashboard calculations. They are still durably recorded.
  return "ignored";
}

async function handleOpenPhoneWebhook(req: Request, res: Response) {
  if (!webhookSecret()) {
    logger.error("quoWebhook: QUO_WEBHOOK_SECRET is not configured");
    return res.status(503).json({ error: "Webhook verification is not configured" });
  }
  if (!Buffer.isBuffer(req.body)) {
    logger.warn("quoWebhook: request did not contain an application/json raw body");
    return res.status(415).json({ error: "Unsupported Media Type" });
  }

  const verification = verifyOpenPhoneSignature(
    req.body,
    req.get("openphone-signature"),
    webhookSecret(),
    { toleranceSeconds: webhookTimestampToleranceSeconds() },
  );
  if (!verification.valid) {
    logger.warn({ reason: verification.reason }, "quoWebhook: signature verification failed");
    return res.status(401).json({ error: "Unauthorized" });
  }

  let delivery: VerifiedWebhookEvent;
  try {
    delivery = parseOpenPhoneWebhook(req.body);
  } catch {
    logger.warn("quoWebhook: rejected malformed signed event envelope");
    return res.status(400).json({ error: "Invalid webhook payload" });
  }

  try {
    const result = await processDurableWebhook(
      delivery,
      openPhoneWebhookInbox,
      processOpenPhoneEvent,
    );
    if (result === "collision") {
      logger.error(
        { providerEventId: delivery.providerEventId, eventType: delivery.eventType },
        "quoWebhook: provider event id reused with a different payload",
      );
      return res.status(409).json({ error: "Webhook event conflict" });
    }
    if (result === "busy") {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "Webhook processing in progress" });
    }
    return res.json({ ok: true });
  } catch (error) {
    const errorCode = sanitizedWebhookErrorCode(error);
    logger.error(
      { providerEventId: delivery.providerEventId, eventType: delivery.eventType, errorCode },
      "quoWebhook: durable processing failed",
    );
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ error: "Webhook processing failed" });
  }
}

router.post("/quo/webhook", handleOpenPhoneWebhook);
router.post("/openphone/webhook", handleOpenPhoneWebhook);

export default router;
