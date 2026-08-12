import type { VerifiedWebhookEvent } from "./openPhoneWebhook.js";

export type WebhookTerminalStatus = "processed" | "ignored";
export type WebhookRecordResult = "recorded" | "known" | "collision";
export type WebhookClaimResult = "claimed" | "terminal" | "busy";
export type WebhookDeliveryResult = "processed" | "ignored" | "duplicate" | "busy" | "collision";

export interface DurableWebhookStore {
  record(event: VerifiedWebhookEvent): Promise<WebhookRecordResult>;
  claim(idempotencyKey: string): Promise<WebhookClaimResult>;
  finish(idempotencyKey: string, status: WebhookTerminalStatus): Promise<void>;
  fail(idempotencyKey: string, errorCode: string): Promise<void>;
}

export class WebhookProcessingError extends Error {
  constructor(public readonly errorCode: string) {
    super(errorCode);
    this.name = "WebhookProcessingError";
  }
}

export function sanitizedWebhookErrorCode(error: unknown): string {
  if (error instanceof WebhookProcessingError && /^[a-z0-9_]{1,64}$/.test(error.errorCode)) {
    return error.errorCode;
  }
  return "processing_failed";
}

export async function processDurableWebhook(
  event: VerifiedWebhookEvent,
  store: DurableWebhookStore,
  processor: (event: VerifiedWebhookEvent) => Promise<WebhookTerminalStatus>,
): Promise<WebhookDeliveryResult> {
  const recorded = await store.record(event);
  if (recorded === "collision") return "collision";

  const claim = await store.claim(event.idempotencyKey);
  if (claim === "terminal") return "duplicate";
  if (claim === "busy") return "busy";

  try {
    const status = await processor(event);
    await store.finish(event.idempotencyKey, status);
    return status;
  } catch (error) {
    try {
      await store.fail(event.idempotencyKey, sanitizedWebhookErrorCode(error));
    } catch {
      // Preserve the original failure. A provider retry can reclaim a stale
      // processing lease even if recording this sanitized failure also fails.
    }
    throw error;
  }
}
