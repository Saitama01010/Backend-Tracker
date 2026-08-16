import { parseSheetGid } from "../../lib/externalIntegrationPolicy.js";
import { validateIntegrationDateRange } from "../../lib/externalIntegrationPolicy.js";
import type { RetentionReadyModeQuery, RetentionSheetQuery } from "./retention.types.js";

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
