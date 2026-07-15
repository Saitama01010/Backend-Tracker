import type Anthropic from "@anthropic-ai/sdk";

export function assistantBlocks(response: Anthropic.Message): Anthropic.ContentBlockParam[] {
  return response.content.flatMap((block): Anthropic.ContentBlockParam[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "tool_use") {
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    }
    return [];
  });
}
export function toolResultMessage(results: Anthropic.ToolResultBlockParam[]): Anthropic.MessageParam {
  return { role: "user", content: results };
}

export type SamiaPayloadValidation =
  | { ok: true; message: string; displayName?: string; images: string[] }
  | { ok: false; status: number; error: string };

export function validateSamiaPayload(body: unknown): SamiaPayloadValidation {
  const value = (body ?? {}) as Record<string, unknown>;
  const message = typeof value["message"] === "string" ? value["message"].trim() : "";
  const displayName = typeof value["displayName"] === "string" ? value["displayName"].slice(0, 100) : undefined;
  const rawImages = Array.isArray(value["images"]) ? value["images"] : [];
  if (!message) return { ok: false, status: 400, error: "message is required" };
  if (message.length > 4_000) return { ok: false, status: 413, error: "message must be 4,000 characters or fewer" };
  if (rawImages.length > 2 || rawImages.some((image) => typeof image !== "string")) {
    return { ok: false, status: 400, error: "A maximum of two images is allowed" };
  }
  let totalImageBytes = 0;
  for (const image of rawImages as string[]) {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/s.exec(image);
    if (!match?.[2]) {
      return { ok: false, status: 400, error: "Images must be JPEG, PNG, GIF, or WebP data URLs" };
    }
    const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
    const bytes = Math.floor(match[2].length * 3 / 4) - padding;
    if (bytes > 3 * 1024 * 1024) {
      return { ok: false, status: 413, error: "Each image must be 3 MB or smaller" };
    }
    totalImageBytes += bytes;
  }
  if (totalImageBytes > 6 * 1024 * 1024) {
    return { ok: false, status: 413, error: "Combined image payload must be 6 MB or smaller" };
  }
  return { ok: true, message, displayName, images: rawImages as string[] };
}

const MODEL_IDENTITY_PATTERNS = [
  /\bwhat(?:'s| is)\s+(?:your|the)\s+(?:ai\s+)?model\b/i,
  /\bwhat\s+(?:ai\s+)?model\s+are\s+you\b/i,
  /\bwhich\s+(?:ai\s+)?model\s+(?:do|are)\s+you\s+(?:use|using)\b/i,
  /\bwhich\s+ai\s+are\s+you\b/i,
  /\bwhat\s+(?:ai|llm)\s+are\s+you\b/i,
  /\bwhat\s+(?:ai|llm|model)\s+(?:do|are)\s+you\s+(?:use|using)\b/i,
  /\bare\s+you\s+(?:gpt(?:[-\s]?\d+(?:\.\d+)?)?|chatgpt|claude|openai|openrouter|gemini|qwen|llama)\b/i,
  /\bare\s+you\s+(?:powered|hosted|made)\s+by\s+(?:gpt|chatgpt|claude|anthropic|openai|openrouter|gemini|qwen|llama)\b/i,
  /\bwho\s+powers\s+you\b/i,
  /\bwhat\s+are\s+you\s+powered\s+by\b/i,
  /\bwho\s+(?:made|built|hosts?)\s+you\b/i,
  /\bwhat\s+provider\s+do\s+you\s+use\b/i,
  /\bwhich\s+provider\s+(?:are\s+you|powers|hosts)\b/i,
  /\b(?:tell|show)\s+me\s+(?:your|the)\s+(?:model|provider)\b/i,
  /\bdo\s+you\s+use\s+(?:gpt|chatgpt|claude|anthropic|openai|openrouter|gemini|qwen|llama)\b/i,
];

export function isModelIdentityQuestion(message: string): boolean {
  const normalized = message.replace(/[\u2018\u2019]/g, "'").trim();
  return MODEL_IDENTITY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function claudeModelDisplayName(model: string): string {
  const match = /^claude-(sonnet|haiku|opus)-(\d+)(?:-(\d+))?$/i.exec(model.trim());
  if (!match?.[1] || !match[2]) return model;
  const family = match[1][0]!.toUpperCase() + match[1].slice(1).toLowerCase();
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `Claude ${family} ${version}`;
}

export function deterministicIdentityReply(model: string): string {
  return `I'm Samia, powered by Anthropic Claude using ${claudeModelDisplayName(model)}.`;
}

const FALSE_MODEL_PROVIDER = String.raw`(?:gpt(?:[-\s]?\d[\w.-]*)?|chatgpt|openai|openrouter|gemini|qwen|llama)`;
const FALSE_ASSISTANT_IDENTITY_PATTERNS = [
  new RegExp(String.raw`(?:^|[\n.!?]\s*)(?:i\s+am|i['\u2019]m|i\s+use|i\s+run\s+on|my\s+(?:model|provider|underlying\s+model)\s+is)\b.{0,100}\b${FALSE_MODEL_PROVIDER}\b`, "i"),
  new RegExp(String.raw`(?:^|[\n.!?]\s*)(?:i\s+am|i['\u2019]m|i\s+was|samia\s+is|this\s+assistant\s+is)\b.{0,100}\b(?:powered|hosted|made|created)\s+by\s+${FALSE_MODEL_PROVIDER}\b`, "i"),
  new RegExp(String.raw`^\s*as\s+(?:an?\s+)?${FALSE_MODEL_PROVIDER}\b`, "i"),
];

export function isStaleModelIdentityMessage(role: string, content: string): boolean {
  if (role !== "assistant") return false;
  return FALSE_ASSISTANT_IDENTITY_PATTERNS.some((pattern) => pattern.test(content));
}

export type UsPhoneNumberExtraction =
  | { found: false }
  | {
      found: true;
      original: string;
      digits: string;
      e164: string;
      masked: string;
    };

const US_PHONE_PATTERN = /(?<![\dA-Za-z])(?:\+?1[\s.-]*)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]*[2-9]\d{2}[\s.-]*\d{4}(?![\dA-Za-z])/;

export function extractUsPhoneNumber(message: string): UsPhoneNumberExtraction {
  const match = US_PHONE_PATTERN.exec(message);
  if (!match?.[0]) return { found: false };
  const rawDigits = match[0].replace(/\D/g, "");
  const digits = rawDigits.length === 11 && rawDigits.startsWith("1")
    ? rawDigits.slice(1)
    : rawDigits;
  if (digits.length !== 10) return { found: false };
  return {
    found: true,
    original: match[0],
    digits,
    e164: `+1${digits}`,
    masked: `******${digits.slice(-4)}`,
  };
}

const CLEARLY_NON_CALL_PHONE_CONTEXT = [
  /\b(?:format|reformat|validate)\s+(?:this|the|my|our)?\s*(?:phone\s+)?number\b/i,
  /\b(?:my|our)\s+phone\s+number\s+is\b/i,
  /\b(?:save|remember|store)\s+(?:this|the|my|our)?\s*(?:phone\s+)?number\b/i,
  /\bhow\s+(?:do|should|can)\s+i\s+(?:write|format)\s+(?:this|the|a)?\s*(?:phone\s+)?number\b/i,
  /^\s*(?:please\s+)?(?:dial|text|message)\s+(?:this\s+)?(?:number\s+)?/i,
];

export function shouldRoutePhoneNumberToCallData(message: string): boolean {
  if (!extractUsPhoneNumber(message).found) return false;
  return !CLEARLY_NON_CALL_PHONE_CONTEXT.some((pattern) => pattern.test(message));
}

const INTERNAL_TOOL_NAME_PATTERN = /\b(?:analyze_calls|lookup_number|get_agent_contacts|auto_mark_attendance|get_call_logs|set_attendance|add_nsf_readymode_missed_calls)\b/i;

export function hasVisibleInternalToolSyntax(reply: string): boolean {
  return INTERNAL_TOOL_NAME_PATTERN.test(reply) || /\btool_(?:use|result)\b/i.test(reply);
}

export function safeVisibleSamiaReply(reply: string): string {
  if (!hasVisibleInternalToolSyntax(reply)) return reply;
  return "I couldn't complete that dashboard lookup safely. Please try again.";
}

export interface SamiaErrorMapping {
  status: number;
  error: string;
  retryAfter?: number;
}

export function mapSamiaError(error: unknown, model: string): SamiaErrorMapping {
  const value = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  const status = typeof value?.status === "number" ? value.status : null;
  const pgCode = typeof value?.code === "string" ? value.code : null;
  const message = typeof value?.message === "string" ? value.message : "";
  const name = typeof value?.name === "string" ? value.name : "";

  if (pgCode === "42P01" && /ai_request_usage|qa_biweekly_runs/i.test(message)) {
    return { status: 503, error: "Samia's database controls are not migrated. Run the database migration and retry." };
  }
  if (pgCode) return { status: 500, error: "Samia encountered a database error. Check the server logs." };
  if (/ANTHROPIC_API_KEY/.test(message)) {
    return { status: 500, error: "Samia is missing server-side AI configuration." };
  }
  if (status === 401) return { status: 502, error: "Claude rejected the configured API key. Update ANTHROPIC_API_KEY on the server." };
  if (status === 403) return { status: 502, error: "The Claude API key does not have access to the configured model." };
  if (status === 404) return { status: 502, error: `Claude model ${model} was not found. Check ANTHROPIC_SAMIA_MODEL on the server.` };
  if (status === 429) return { status: 429, error: "Claude is temporarily rate-limited. Please retry shortly.", retryAfter: 60 };
  if (status === 402) return { status: 402, error: "The Anthropic account has a billing or payment issue." };
  if (status === 529) return { status: 503, error: "Claude is temporarily overloaded. Please retry shortly." };
  if (status === 413) return { status: 413, error: "That message or screenshot is too large for Claude. Try a smaller image." };
  if (/timeout|timed out|aborted/i.test(message) || /Timeout|Abort/i.test(name)) {
    return { status: 504, error: "Claude took too long to respond. Please try again." };
  }
  if (status) return { status: 502, error: `Claude request failed with HTTP ${status}. Check the server logs.` };
  return { status: 500, error: "Samia failed before receiving a Claude response. Check the server logs." };
}
