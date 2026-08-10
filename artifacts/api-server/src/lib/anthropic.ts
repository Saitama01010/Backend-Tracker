import Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicConfigurationError,
  createAnthropicClient as createSharedAnthropicClient,
} from "./anthropicClient.cjs";
import {
  anthropicRequestTimeoutMs,
  assertAllowedAnthropicModel,
  boundAiInput,
  boundedAnthropicMaxTokens,
  safeAiErrorCode,
} from "./aiPrivacy.js";

export { AnthropicConfigurationError };
// Client construction performs no network request. Every feature invokes the
// Messages API only from its authenticated request/scheduled execution path.
export function createAnthropicClient(): Anthropic {
  return createSharedAnthropicClient() as Anthropic;
}

export function anthropicErrorStatus(error: unknown): number | null {
  return typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : null;
}

export function anthropicRequestId(error: unknown): string | null {
  const value = (error as { request_id?: unknown })?.request_id;
  return typeof value === "string" ? value : null;
}

export function isPermanentAnthropicError(error: unknown): boolean {
  if (error instanceof AnthropicConfigurationError) return true;
  const status = anthropicErrorStatus(error);
  return status !== null && [400, 401, 402, 403, 404, 422].includes(status);
}

export function sanitizedErrorMessage(error: unknown): string {
  return safeAiErrorCode(error);
}

export type AnthropicMessageWithRequestId = Anthropic.Message & { _request_id?: string | null };

export async function createAnthropicToolMessage(options: {
  model: string;
  system: string;
  prompt: string;
  tool: Anthropic.Tool;
  maxTokens?: number;
}): Promise<AnthropicMessageWithRequestId> {
  const model = assertAllowedAnthropicModel(options.model);
  return createAnthropicClient().messages.create({
    model,
    max_tokens: boundedAnthropicMaxTokens(options.maxTokens ?? 256),
    system: [{ type: "text", text: boundAiInput(options.system), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: boundAiInput(options.prompt) }],
    tools: [{ ...options.tool, strict: true }],
    tool_choice: { type: "tool", name: options.tool.name },
  }, { signal: AbortSignal.timeout(anthropicRequestTimeoutMs()) });
}

export function toolInput(message: Anthropic.Message, toolName: string): unknown | null {
  const block = message.content.find(
    (item): item is Anthropic.ToolUseBlock => item.type === "tool_use" && item.name === toolName,
  );
  return block?.input ?? null;
}

export function usageFields(usage: Anthropic.Usage) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}
