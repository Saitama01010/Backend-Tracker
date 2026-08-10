const Anthropic = require("@anthropic-ai/sdk");

class AnthropicConfigurationError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "AnthropicConfigurationError";
  }
}

function createAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new AnthropicConfigurationError();
  const configuredTimeout = Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS);
  const timeout = Number.isFinite(configuredTimeout)
    ? Math.max(5000, Math.min(60000, Math.trunc(configuredTimeout)))
    : 30000;
  return new Anthropic({ apiKey, maxRetries: 1, timeout });
}

module.exports = { AnthropicConfigurationError, createAnthropicClient };
