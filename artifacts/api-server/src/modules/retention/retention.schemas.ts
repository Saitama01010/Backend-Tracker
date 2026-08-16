import { parseSheetGid } from "../../lib/externalIntegrationPolicy.js";
import { validateIntegrationDateRange } from "../../lib/externalIntegrationPolicy.js";
import type {
  RetentionQuoStatsQuery,
  RetentionReadyModeQuery,
  RetentionSheetQuery,
} from "./retention.types.js";

export type RetentionSheetQueryResult =
  | { ok: true; query: RetentionSheetQuery }
  | { ok: false; error: "missing or invalid id" | "invalid gid" };

export function parseRetentionSheetQuery(raw: Record<string, unknown>): RetentionSheetQueryResult {
  const spreadsheetId = String(raw["id"] ?? "").trim();
  if (!spreadsheetId || !/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) {
    return { ok: false, error: "missing or invalid id" };
  }

  const gid = parseSheetGid(String(raw["gid"] ?? "0"));
  if (gid === null) return { ok: false, error: "invalid gid" };

  return {
    ok: true,
    query: {
      spreadsheetId,
      gid,
      compact: raw["format"] === "rows-v1",
    },
  };
}

export function retentionReadyModeDateInput(raw: Record<string, unknown>): RetentionReadyModeQuery {
  return {
    fromIso: typeof raw["from"] === "string" ? raw["from"] : undefined,
    toIso: typeof raw["to"] === "string" ? raw["to"] : undefined,
  };
}

export function validateRetentionReadyModeQuery(
  query: RetentionReadyModeQuery,
): { ok: true; query: RetentionReadyModeQuery } | { ok: false; error: string } {
  const { fromIso, toIso } = query;
  if ((fromIso && !toIso) || (!fromIso && toIso)) {
    return { ok: false, error: "Both from and to are required." };
  }
  if (fromIso && toIso) {
    const range = validateIntegrationDateRange(fromIso, toIso);
    if (!range.ok) return { ok: false, error: range.error };
  }
  return { ok: true, query };
}

export function retentionQuoStatsDateInput(
  raw: Record<string, unknown>,
  now = Date.now(),
): RetentionQuoStatsQuery {
  return {
    from: typeof raw["from"] === "string"
      ? raw["from"]
      : new Date(now - 30 * 86_400_000).toISOString(),
    to: typeof raw["to"] === "string" ? raw["to"] : new Date(now).toISOString(),
  };
}

export function validateRetentionQuoStatsQuery(
  query: RetentionQuoStatsQuery,
): { ok: true; query: RetentionQuoStatsQuery } | { ok: false; error: string } {
  const range = validateIntegrationDateRange(query.from, query.to);
  return range.ok
    ? { ok: true, query: { from: range.from, to: range.to } }
    : { ok: false, error: range.error };
}
