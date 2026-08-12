import type { PoolConfig } from "pg";

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function databasePoolConfig(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  return {
    connectionString,
    // Keep node-postgres' established max/idle defaults explicit and bounded.
    // Operators using a connection pooler can lower DB_POOL_MAX per deployment.
    max: boundedInteger(env.DB_POOL_MAX, DEFAULT_POOL_MAX, 1, 50),
    idleTimeoutMillis: boundedInteger(
      env.DB_POOL_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
      1_000,
      300_000,
    ),
    // node-postgres otherwise waits indefinitely for a new connection.
    connectionTimeoutMillis: boundedInteger(
      env.DB_POOL_CONNECTION_TIMEOUT_MS,
      DEFAULT_CONNECTION_TIMEOUT_MS,
      1_000,
      120_000,
    ),
  };
}
