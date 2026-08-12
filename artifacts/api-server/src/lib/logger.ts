import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const LOGGER_REDACT_PATHS = [
  "authorization",
  "cookie",
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "secret",
  "signature",
  "webhookSignature",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "req.headers['x-api-key']",
  "req.headers['api-key']",
  "req.headers['openphone-signature']",
  "req.headers['x-webhook-signature']",
  "req.headers['x-signature']",
  "res.headers['set-cookie']",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.secret",
  "*.signature",
  "*.webhookSignature",
] as const;

export function redactSensitiveLogText(value: string): string {
  let redacted = value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(
    /\b(authorization|cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|(?:webhook[_-]?)?signature)\b\s*([:=])\s*([^\s,;&]+)/gi,
    "$1$2[REDACTED]",
  );
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(?:PASSWORD|TOKEN|SECRET|API_KEY|SIGNATURE|COOKIE|AUTHORIZATION|DATABASE_URL|PGPASSWORD)/i.test(name)
      || typeof secret !== "string" || secret.length < 6) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function errorForSecureLog(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: redactSensitiveLogText(String(error)) };
  }
  const serialized = pino.stdSerializers.err(error as Error) as Record<string, unknown>;
  for (const field of ["body", "headers", "request", "response", "config", "authorization", "cookie", "token", "password", "apiKey", "secret", "signature"]) {
    delete serialized[field];
  }
  for (const field of ["message", "stack"] as const) {
    if (typeof serialized[field] === "string") {
      serialized[field] = redactSensitiveLogText(serialized[field] as string);
    }
  }
  return serialized;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: [...LOGGER_REDACT_PATHS], censor: "[REDACTED]" },
  serializers: { err: errorForSecureLog, error: errorForSecureLog },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
