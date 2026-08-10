import type { Server } from "node:http";

export const DEFAULT_HTTP_TIMEOUTS = Object.freeze({
  headersTimeout: 15_000,
  requestTimeout: 120_000,
  keepAliveTimeout: 5_000,
  maxHeadersCount: 100,
});

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function configureHttpServerPolicy(
  server: Server,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  server.headersTimeout = boundedInteger(
    environment["HTTP_HEADERS_TIMEOUT_MS"],
    DEFAULT_HTTP_TIMEOUTS.headersTimeout,
    5_000,
    120_000,
  );
  server.requestTimeout = boundedInteger(
    environment["HTTP_REQUEST_TIMEOUT_MS"],
    DEFAULT_HTTP_TIMEOUTS.requestTimeout,
    server.headersTimeout,
    300_000,
  );
  server.keepAliveTimeout = boundedInteger(
    environment["HTTP_KEEP_ALIVE_TIMEOUT_MS"],
    DEFAULT_HTTP_TIMEOUTS.keepAliveTimeout,
    1_000,
    60_000,
  );
  server.maxHeadersCount = boundedInteger(
    environment["HTTP_MAX_HEADERS_COUNT"],
    DEFAULT_HTTP_TIMEOUTS.maxHeadersCount,
    32,
    1_000,
  );
  // Response-duration limits remain route-specific so long report generation
  // and workbook streaming are not terminated mid-download.
  server.timeout = 0;
}
