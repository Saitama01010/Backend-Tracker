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
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 30000 });
}

module.exports = { AnthropicConfigurationError, createAnthropicClient };
