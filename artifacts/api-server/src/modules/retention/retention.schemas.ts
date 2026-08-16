import { parseSheetGid } from "../../lib/externalIntegrationPolicy.js";
import type { RetentionSheetQuery } from "./retention.types.js";

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
