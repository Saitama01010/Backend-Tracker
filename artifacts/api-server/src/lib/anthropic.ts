import Anthropic from "@anthropic-ai/sdk";

export class AnthropicConfigurationError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "AnthropicConfigurationError";
  }
}
// Client construction performs no network request. Every feature invokes the
// Messages API only from its authenticated request/scheduled execution path.
export function createAnthropicClient(): Anthropic {
  const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  if (!apiKey) throw new AnthropicConfigurationError();
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
}

export function anthropicErrorStatus(error: unknown): number | null {
  return typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : null;
}

export function usageFields(usage: Anthropic.Usage) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}
