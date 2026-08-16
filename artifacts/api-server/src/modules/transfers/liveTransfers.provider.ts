import {
  fetchQuoTranscript,
  type QuoDialogueLine,
} from "../../integrations/quo/transcripts.js";
import { AI_UNTRUSTED_DATA_SYSTEM_POLICY, wrapUntrustedAiData } from "../../lib/aiPrivacy.js";
import {
  anthropicErrorStatus,
  anthropicRequestId,
  createAnthropicToolMessage,
  isPermanentAnthropicError,
  sanitizedErrorMessage,
  toolInput,
  usageFields,
} from "../../lib/anthropic.js";
import { logger } from "../../lib/logger.js";
import { OPERATIONAL_CONFIG } from "../../lib/operationalConfig.js";

const MODEL = OPERATIONAL_CONFIG.aiModels.liveTransfers;

const SYSTEM_PROMPT = `You analyze the OPENING of an INCOMING phone call to a debt-relief company. Classify whether the call is a warm-transfer (someone handing a client off to this team), and if so, what KIND.
${AI_UNTRUSTED_DATA_SYSTEM_POLICY}

Two kinds of transfer:
1. PARTNER — a representative from an EXTERNAL partner company warm-transfers a client to us. The partner companies are "Aspire", "Resync" (sometimes said "re-sync"), "Clarity", and "Concordia". e.g. "Hi, this is Marcus with Aspire, I have a client for you".
2. INTERNAL — one of OUR OWN departments/agents hands the client to this team. Internal departments include Customer Service ("CS"), "NSF", "Retention", "Onboarding", "Billing", "Sales". e.g. "Hey, it's Sarah from the NSF team, I've got a customer who needs...".

If the caller is the client themselves, a company name is only mentioned in passing, or it is any other kind of call, it is NOT a transfer. Submit the classification through the provided tool.`;

const CLASSIFICATION_TOOL = {
  name: "record_live_transfer_classification",
  description: "Record the validated classification for this call opening.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ["partner", "internal", "none"] },
      company: { type: "string", maxLength: 80 },
      agent: { type: "string", maxLength: 100 },
      evidence: { type: "string", maxLength: 180 },
    },
    required: ["kind", "company", "agent", "evidence"],
    additionalProperties: false,
  },
};

export type LiveTransferKind = "partner" | "internal" | "none";

export interface LiveTransferExtractResult {
  kind: LiveTransferKind;
  company: string;
  agent: string;
  evidence: string;
}

export type LiveTransferExtractAttempt =
  | { status: "ok"; value: LiveTransferExtractResult }
  | { status: "temporary_error" }
  | { status: "permanent_error" };

export function validateLiveTransferClassification(value: unknown): LiveTransferExtractResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!(["partner", "internal", "none"] as unknown[]).includes(raw["kind"])) return null;
  if (typeof raw["company"] !== "string" || typeof raw["agent"] !== "string" || typeof raw["evidence"] !== "string") return null;
  if (raw["company"].length > 80 || raw["agent"].length > 100 || raw["evidence"].length > 180) return null;
  return {
    kind: raw["kind"] as LiveTransferKind,
    company: raw["company"].trim(),
    agent: raw["agent"].trim(),
    evidence: raw["evidence"].trim(),
  };
}

export interface LiveTransferProvider {
  fetchTranscript(callId: string): ReturnType<typeof fetchQuoTranscript>;
  buildTranscript(dialogue: QuoDialogueLine[]): string;
  classify(transcript: string): Promise<LiveTransferExtractAttempt>;
}

export class QuoAnthropicLiveTransferProvider implements LiveTransferProvider {
  fetchTranscript(callId: string) {
    return fetchQuoTranscript(callId);
  }

  buildTranscript(dialogue: QuoDialogueLine[]): string {
    return dialogue
      .map((entry) => (entry.content ?? "").trim())
      .filter(Boolean)
      .join("\n");
  }

  async classify(transcript: string): Promise<LiveTransferExtractAttempt> {
    try {
      const response = await createAnthropicToolMessage({
        model: MODEL,
        system: SYSTEM_PROMPT,
        prompt: wrapUntrustedAiData("quo_opening_transcript", transcript, 4_000),
        tool: CLASSIFICATION_TOOL,
        maxTokens: 256,
      });
      logger.info({
        feature: "live_transfer_classification",
        model: response.model,
        requestId: response._request_id,
        success: true,
        ...usageFields(response.usage),
      }, "anthropic request complete");
      const value = validateLiveTransferClassification(toolInput(response, CLASSIFICATION_TOOL.name));
      return value ? { status: "ok", value } : { status: "permanent_error" };
    } catch (error) {
      logger.warn({
        feature: "live_transfer_classification",
        model: MODEL,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: sanitizedErrorMessage(error),
        anthropicStatus: anthropicErrorStatus(error),
        anthropicRequestId: anthropicRequestId(error),
        success: false,
      }, "anthropic request failed");
      return { status: isPermanentAnthropicError(error) ? "permanent_error" : "temporary_error" };
    }
  }
}

export const liveTransferProvider = new QuoAnthropicLiveTransferProvider();
