import { validateIntegrationCalendarDate } from "../../lib/externalIntegrationPolicy.js";

export type PbxMissedMode = "numbers" | "times";

export type PbxHourlyQuery = {
  date: string;
  mode: PbxMissedMode;
};

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
