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
