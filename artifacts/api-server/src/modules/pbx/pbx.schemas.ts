import { validateIntegrationCalendarDate } from "../../lib/externalIntegrationPolicy.js";

export type PbxMissedMode = "numbers" | "times";

export type PbxHourlyQuery = {
  date: string;
  mode: PbxMissedMode;
};

export type PbxDailyQuery = {
  mode: PbxMissedMode;
};

export type PbxBreakdownQuery = { date: string };

export function parsePbxHourlyQuery(
  query: Record<string, unknown>,
  now = new Date(),
): { ok: true; value: PbxHourlyQuery } | { ok: false; error: string } {
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const date = typeof query["date"] === "string" ? query["date"] : today;
  if (!validateIntegrationCalendarDate(date)) {
    return { ok: false, error: "Invalid date; expected YYYY-MM-DD." };
  }
  return {
    ok: true,
    value: {
      date,
      mode: query["mode"] === "numbers" ? "numbers" : "times",
    },
  };
}

export function parsePbxDailyQuery(query: Record<string, unknown>): PbxDailyQuery {
  return { mode: query["mode"] === "numbers" ? "numbers" : "times" };
}

export function parsePbxBreakdownQuery(
  query: Record<string, unknown>,
): { ok: true; value: PbxBreakdownQuery } | { ok: false; error: string } {
  const date = typeof query["date"] === "string" ? query["date"] : null;
  if (!date) return { ok: false, error: "date required (YYYY-MM-DD)" };
  if (!validateIntegrationCalendarDate(date)) {
    return { ok: false, error: "Invalid date; expected YYYY-MM-DD." };
  }
  return { ok: true, value: { date } };
}
