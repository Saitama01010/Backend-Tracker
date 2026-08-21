import { runSync } from "../../integrations/quo/sync.js";
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

const LINE_NUMBER = OPERATIONAL_CONFIG.lineIds.onboardingNumber;
const MODEL = OPERATIONAL_CONFIG.aiModels.onboarding;

const SYSTEM_PROMPT = `You analyze transcripts from a debt-relief company's ONBOARDING phone line (Better Lending).
${AI_UNTRUSTED_DATA_SYSTEM_POLICY}
On this line, a closer/sales rep usually warm-transfers a customer who just signed up, and the ONBOARDING agent enrolls them (collects file/case number, sets up the payment schedule, confirms the program, welcomes them).
Return the result only through the provided classification tool with these fields:
{
  "customerName": string | null,   // the CUSTOMER's full name as stated on the call (not the agent). null if unknown.
  "closerAgent": string | null,    // name of the SALES CLOSER who closed the deal and warm-transferred the customer, IF mentioned (e.g. "transferred from John", "I have X for you", a rep who hands off then leaves). NOT the onboarding agent. null if none.
  "callType": "onboarded" | "connection" | "other",
  "notes": string                  // <= 12 words, why you chose callType
}
callType rubric:
- "onboarded": the customer was actually enrolled/onboarded — file or case number taken, payment/draft schedule set up, program confirmed, welcome to the program.
- "connection": someone called to get connected / inquire / was transferred but was NOT onboarded — just a connection, a question, not ready, declined, wrong dept, callback only, no enrollment completed.
- "other": internal/test/unclear/no real conversation.`;

const CLASSIFICATION_TOOL = {
  name: "record_onboarding_classification",
  description: "Record the validated onboarding-call classification.",
  input_schema: {
    type: "object" as const,
    properties: {
      customerName: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
      closerAgent: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
      callType: { type: "string", enum: ["onboarded", "connection", "other"] },
      notes: { type: "string", maxLength: 180 },
    },
    required: ["customerName", "closerAgent", "callType", "notes"],
    additionalProperties: false,
  },
};

export interface OnboardingClassifyResult {
  customerName: string | null;
  closerAgent: string | null;
  callType: string;
  notes: string;
}

export type OnboardingClassifyAttempt =
  | { status: "ok"; value: OnboardingClassifyResult }
  | { status: "temporary_error" }
  | { status: "permanent_error" };

export function validateOnboardingClassification(value: unknown): OnboardingClassifyResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const nullableString = (item: unknown, maximum: number) =>
    item === null || (typeof item === "string" && item.length <= maximum);
  if (!nullableString(raw["customerName"], 120) || !nullableString(raw["closerAgent"], 120)) return null;
  if (!( ["onboarded", "connection", "other"] as unknown[]).includes(raw["callType"])) return null;
  if (typeof raw["notes"] !== "string" || raw["notes"].length > 180) return null;
  return {
    customerName: typeof raw["customerName"] === "string" ? raw["customerName"].trim() || null : null,
    closerAgent: typeof raw["closerAgent"] === "string" ? raw["closerAgent"].trim() || null : null,
    callType: raw["callType"] as string,
    notes: raw["notes"].trim(),
  };
}

export interface OnboardingReportProvider {
  syncRecent(from: Date, to: Date, lineId: string, signal?: AbortSignal): Promise<void>;
  fetchTranscript(callId: string): ReturnType<typeof fetchQuoTranscript>;
  buildTranscript(dialogue: QuoDialogueLine[]): string;
  classify(agentName: string | null, direction: string, transcript: string): Promise<OnboardingClassifyAttempt>;
}

export class QuoAnthropicOnboardingReportProvider implements OnboardingReportProvider {
  async syncRecent(from: Date, to: Date, lineId: string, signal?: AbortSignal): Promise<void> {
    await runSync(from, to, { onlyLineId: lineId, signal });
  }

  fetchTranscript(callId: string) {
    return fetchQuoTranscript(callId);
  }

  buildTranscript(dialogue: QuoDialogueLine[]): string {
    const lines: string[] = [];
    for (const entry of dialogue) {
      const who = entry.identifier === LINE_NUMBER ? "AGENT" : "CUSTOMER";
      const content = (entry.content ?? "").trim();
      if (content) lines.push(`${who}: ${content}`);
    }
    let text = lines.join("\n");
    if (text.length > 14_000) text = `${text.slice(0, 11_000)}\n...\n${text.slice(-3_000)}`;
    return text;
  }

  async classify(
    _agentName: string | null,
    direction: string,
    transcript: string,
  ): Promise<OnboardingClassifyAttempt> {
    try {
      const response = await createAnthropicToolMessage({
        model: MODEL,
        system: SYSTEM_PROMPT,
        prompt: `Onboarding agent identity: [AUTHORIZED_EMPLOYEE]\nDirection: ${direction}\n\n${wrapUntrustedAiData("quo_onboarding_transcript", transcript, 14_000)}`,
        tool: CLASSIFICATION_TOOL,
        maxTokens: 256,
      });
      logger.info({
        feature: "outbound_call_classification",
        model: response.model,
        requestId: response._request_id,
        success: true,
        ...usageFields(response.usage),
      }, "anthropic request complete");
      const value = validateOnboardingClassification(toolInput(response, CLASSIFICATION_TOOL.name));
      return value ? { status: "ok", value } : { status: "permanent_error" };
    } catch (error) {
      logger.warn({
        feature: "outbound_call_classification",
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

export const onboardingReportProvider = new QuoAnthropicOnboardingReportProvider();
