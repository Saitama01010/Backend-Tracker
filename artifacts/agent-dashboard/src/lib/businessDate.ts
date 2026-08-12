import { DASHBOARD_OPERATIONAL_CONFIG } from "./dashboardConfig";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value;
}

export function addCalendarDays(value: string, days: number): string {
  if (!isCalendarDate(value) || !Number.isSafeInteger(days)) throw new Error("Invalid calendar-day input");
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function formatBusinessDate(
  instant = new Date(),
  timeZone = DASHBOARD_OPERATIONAL_CONFIG.businessTimeZone,
): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function zonedDateTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}, timeZone: string): Date {
  const desired = Date.UTC(input.year, input.month - 1, input.day, input.hour ?? 0, input.minute ?? 0, input.second ?? 0);
  let instant = desired;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const observed = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const correction = desired - observed;
    instant += correction;
    if (correction === 0) break;
  }
  return new Date(instant);
}

export function startOfBusinessDay(date: string): Date {
  if (!isCalendarDate(date)) throw new Error("Invalid business date");
  const [year, month, day] = date.split("-").map(Number);
  return zonedDateTimeToUtc({ year: year!, month: month!, day: day! }, DASHBOARD_OPERATIONAL_CONFIG.businessTimeZone);
}

export function businessDateApiRange(from: string, to: string): { from: string; to: string } {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) throw new Error("Invalid business date range");
  return {
    from: startOfBusinessDay(from).toISOString(),
    to: new Date(startOfBusinessDay(addCalendarDays(to, 1)).getTime() - 1).toISOString(),
  };
}

export function parseStaffTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(trimmed);
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(trimmed);
  if (!us && !iso) return null;
  const year = Number(us?.[3] ?? iso?.[1]);
  const month = Number(us?.[1] ?? iso?.[2]);
  const day = Number(us?.[2] ?? iso?.[3]);
  const hour = Number(us?.[4] ?? iso?.[4]);
  const minute = Number(us?.[5] ?? iso?.[5]);
  const second = Number(us?.[6] ?? iso?.[6] ?? 0);
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (date < DASHBOARD_OPERATIONAL_CONFIG.timezoneCorrectnessCutover) {
    const legacy = new Date(Date.UTC(year, month - 1, day, hour - 2, minute, second));
    return Number.isFinite(legacy.getTime()) ? legacy : null;
  }
  const result = zonedDateTimeToUtc({ year, month, day, hour, minute, second }, DASHBOARD_OPERATIONAL_CONFIG.staffTimeZone);
  return Number.isFinite(result.getTime()) ? result : null;
}
