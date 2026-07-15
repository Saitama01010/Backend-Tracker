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
  return { ok: true, message, displayName, images: rawImages as string[] };
}
