import { createHmac } from "node:crypto";

function hashingSecret(): string {
  const value =
    process.env["RATE_LIMIT_HASH_SECRET"] ?? process.env["SESSION_SECRET"];
  if (value) return value;
  if (
    process.env["NODE_ENV"] === "production" ||
    process.env["VERCEL"] === "1"
  ) {
    throw new Error(
      "RATE_LIMIT_HASH_SECRET or SESSION_SECRET is required in production.",
    );
  }
  return "development-rate-limit-secret";
}

export function privateScopeHash(value: string): string {
  return createHmac("sha256", hashingSecret()).update(value).digest("hex");
}

/** Fixed 65,536-bucket keyspace for anonymous durable rate limits. */
export function boundedAnonymousScope(value: string): string {
  return privateScopeHash(value).slice(0, 4);
}
