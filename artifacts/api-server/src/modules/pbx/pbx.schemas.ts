import {
  parseBoundedInteger,
  validateIntegrationCalendarDate,
  validateIntegrationDateRange,
} from "../../lib/externalIntegrationPolicy.js";

export type PbxMissedMode = "numbers" | "times";

export type PbxHourlyQuery = {
  date: string;
  mode: PbxMissedMode;
};

export type PbxDailyQuery = {
  mode: PbxMissedMode;
};

export type PbxBreakdownQuery = { date: string };
export type PbxCallbackReviewQuery =
  | { kind: "range"; from: string; to: string }
  | { kind: "days"; days: number };

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

export function parsePbxCallbackReviewQuery(
  query: Record<string, unknown>,
): { ok: true; value: PbxCallbackReviewQuery } | { ok: false; error: string } {
  const from = typeof query["from"] === "string" ? query["from"] : null;
  const to = typeof query["to"] === "string" ? query["to"] : null;
  if ((from && !to) || (!from && to)) {
    return { ok: false, error: "Both from and to are required." };
  }
  if (from && to) {
    const range = validateIntegrationDateRange(from, to, 90);
    return range.ok
      ? { ok: true, value: { kind: "range", from, to } }
      : { ok: false, error: range.error };
  }
  const days = parseBoundedInteger(query["days"], 14, { min: 1, max: 90 });
  return days === null
    ? { ok: false, error: "Invalid days; expected an integer from 1 to 90." }
    : { ok: true, value: { kind: "days", days } };
}
