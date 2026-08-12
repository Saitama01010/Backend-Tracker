import type { Request } from "express";
import { pool } from "@workspace/db";
export { boundedAnonymousScope, privateScopeHash } from "./privateScope.js";

export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfter: number;
}

interface RateLimitRow {
  request_count: number | string;
  retry_after: number | string;
}

export function requestAddress(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export async function consumeFixedWindow(
  scopeKey: string,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  const result = await pool.query<RateLimitRow>(
    `INSERT INTO api_rate_limits (scope_key, action, window_started_at, request_count, updated_at)
     VALUES ($1, $2, now(), 1, now())
     ON CONFLICT (scope_key, action) DO UPDATE SET
       window_started_at = CASE
         WHEN api_rate_limits.window_started_at <= now() - make_interval(secs => $3)
         THEN now() ELSE api_rate_limits.window_started_at END,
       request_count = CASE
         WHEN api_rate_limits.window_started_at <= now() - make_interval(secs => $3)
         THEN 1 ELSE api_rate_limits.request_count + 1 END,
       updated_at = now()
     RETURNING request_count,
       greatest(1, ceil(extract(epoch FROM (window_started_at + make_interval(secs => $3) - now())))) AS retry_after`,
    [scopeKey, action, windowSeconds],
  );
  const count = Number(result.rows[0]?.request_count ?? 1);
  const retryAfter = Number(result.rows[0]?.retry_after ?? windowSeconds);
  return { allowed: count <= limit, count, limit, retryAfter: Math.max(1, Math.ceil(retryAfter)) };
}

export async function inspectFixedWindow(
  scopeKey: string,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  const result = await pool.query<RateLimitRow>(
    `SELECT request_count,
       greatest(1, ceil(extract(epoch FROM (window_started_at + make_interval(secs => $3) - now())))) AS retry_after
     FROM api_rate_limits
     WHERE scope_key = $1 AND action = $2
       AND window_started_at > now() - make_interval(secs => $3)`,
    [scopeKey, action, windowSeconds],
  );
  const count = Number(result.rows[0]?.request_count ?? 0);
  const retryAfter = Number(result.rows[0]?.retry_after ?? windowSeconds);
  return { allowed: count < limit, count, limit, retryAfter: Math.max(1, Math.ceil(retryAfter)) };
}

export async function clearFixedWindow(scopeKey: string, action: string): Promise<void> {
  await pool.query("DELETE FROM api_rate_limits WHERE scope_key = $1 AND action = $2", [scopeKey, action]);
}
