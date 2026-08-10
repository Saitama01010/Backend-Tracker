import crypto from "node:crypto";

export interface OpenPhoneWebhookEnvelope {
  id: string;
  type: string;
  object?: string;
  apiVersion?: string;
  createdAt?: string;
  data?: {
    object?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface VerifiedWebhookEvent {
  provider: "openphone";
  providerEventId: string;
  idempotencyKey: string;
  eventType: string;
  objectId: string | null;
  payloadHash: string;
  event: OpenPhoneWebhookEnvelope;
}

export type SignatureVerificationResult =
  | { valid: true; timestamp: number }
  | { valid: false; reason: "missing" | "malformed" | "unsupported" | "expired" | "mismatch" };

interface ParsedSignature {
  timestampText: string;
  timestampMs: number;
  digest: Buffer;
}

function parseSignatureCandidate(value: string): ParsedSignature | null {
  const fields = value.trim().split(";");
  if (fields.length !== 4 || fields[0] !== "hmac" || fields[1] !== "1") return null;

  const timestampText = fields[2] ?? "";
  if (!/^\d{10,16}$/.test(timestampText)) return null;
  const parsedTimestamp = Number(timestampText);
  if (!Number.isSafeInteger(parsedTimestamp) || parsedTimestamp <= 0) return null;
  const timestampMs = parsedTimestamp < 1_000_000_000_000
    ? parsedTimestamp * 1_000
    : parsedTimestamp;

  const digestText = fields[3] ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(digestText)) return null;
  const digest = Buffer.from(digestText, "base64");
  if (digest.length !== 32) return null;

  return { timestampText, timestampMs, digest };
}

function decodeSigningSecret(secret: string): Buffer | null {
  const normalized = secret.trim();
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const decoded = Buffer.from(normalized, "base64");
  return decoded.length > 0 ? decoded : null;
}

export function verifyOpenPhoneSignature(
  rawBody: Buffer,
  header: string | undefined,
  signingSecret: string,
  options: { nowMs?: number; toleranceSeconds?: number } = {},
): SignatureVerificationResult {
  if (!header || !signingSecret) return { valid: false, reason: "missing" };
  const key = decodeSigningSecret(signingSecret);
  if (!key) return { valid: false, reason: "malformed" };

  const candidates = header.split(",").map(parseSignatureCandidate).filter((item): item is ParsedSignature => Boolean(item));
  if (candidates.length === 0) {
    const supportedPrefix = header.split(",").some((value) => value.trim().startsWith("hmac;1;"));
    return { valid: false, reason: supportedPrefix ? "malformed" : "unsupported" };
  }

  const nowMs = options.nowMs ?? Date.now();
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const toleranceMs = Math.max(1, toleranceSeconds) * 1_000;
  let foundFreshCandidate = false;

  for (const candidate of candidates) {
    if (Math.abs(nowMs - candidate.timestampMs) > toleranceMs) continue;
    foundFreshCandidate = true;
    const signedBytes = Buffer.concat([
      Buffer.from(`${candidate.timestampText}.`, "utf8"),
      rawBody,
    ]);
    const expected = crypto.createHmac("sha256", key).update(signedBytes).digest();
    if (crypto.timingSafeEqual(expected, candidate.digest)) {
      return { valid: true, timestamp: candidate.timestampMs };
    }
  }

  return { valid: false, reason: foundFreshCandidate ? "mismatch" : "expired" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseOpenPhoneWebhook(rawBody: Buffer): VerifiedWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("invalid_webhook_json");
  }
  if (!isRecord(parsed)) throw new Error("invalid_webhook_envelope");

  const providerEventId = typeof parsed["id"] === "string" ? parsed["id"].trim() : "";
  const eventType = typeof parsed["type"] === "string" ? parsed["type"].trim() : "";
  if (!providerEventId || providerEventId.length > 255 || !eventType || eventType.length > 255) {
    throw new Error("invalid_webhook_envelope");
  }

  const data = isRecord(parsed["data"]) ? parsed["data"] : undefined;
  const object = data && isRecord(data["object"]) ? data["object"] : undefined;
  const rawObjectId = object?.["id"] ?? object?.["callId"];
  const objectId = typeof rawObjectId === "string" && rawObjectId.trim()
    ? rawObjectId.trim().slice(0, 255)
    : null;
  const event = parsed as OpenPhoneWebhookEnvelope;

  return {
    provider: "openphone",
    providerEventId,
    idempotencyKey: `openphone:${providerEventId}`,
    eventType,
    objectId,
    payloadHash: crypto.createHash("sha256").update(canonicalJson(event)).digest("hex"),
    event,
  };
}

export function durableWebhookPayload(event: VerifiedWebhookEvent): Record<string, unknown> {
  if (["call.ringing", "call.answered", "call.completed"].includes(event.eventType)) {
    return event.event;
  }

  // Events that the dashboard does not interpret need only their envelope and
  // object identity for auditing/idempotency. Do not retain message bodies,
  // transcript dialogue, recordings, contacts, or other unused customer data.
  return {
    id: event.providerEventId,
    object: event.event.object,
    apiVersion: event.event.apiVersion,
    createdAt: event.event.createdAt,
    type: event.eventType,
    data: event.objectId ? { object: { id: event.objectId } } : undefined,
  };
}

export function webhookTimestampToleranceSeconds(): number {
  const parsed = Number(process.env["QUO_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS"] ?? "300");
  if (!Number.isInteger(parsed) || parsed < 30 || parsed > 900) return 300;
  return parsed;
}
