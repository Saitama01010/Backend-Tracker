import { OPERATIONAL_CONFIG } from "./operationalConfig.js";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZONELESS_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

function isoFromParts(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return isoFromParts(year!, month!, day!) === value;
}

export function calendarDateParts(value: string): CalendarDateParts {
  if (!isCalendarDate(value)) throw new Error("Calendar date must be a valid YYYY-MM-DD date");
  const [year, month, day] = value.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

export function addCalendarDays(value: string, days: number): string {
  const { year, month, day } = calendarDateParts(value);
  if (!Number.isSafeInteger(days)) throw new Error("Calendar-day offset must be an integer");
  return isoFromParts(year, month, day + days);
}

export function formatCalendarDate(instant: Date, timeZone = OPERATIONAL_CONFIG.businessTimeZone): string {
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid instant");
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
  millisecond?: number;
}, timeZone: string): Date {
  const desiredWallTime = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour ?? 0,
    input.minute ?? 0,
    input.second ?? 0,
    input.millisecond ?? 0,
  );
  let instant = desiredWallTime;
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
    const observedWallTime = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      input.millisecond ?? 0,
    );
    const correction = desiredWallTime - observedWallTime;
    instant += correction;
    if (correction === 0) break;
  }
  const result = new Date(instant);
  if (!Number.isFinite(result.getTime())) throw new Error("Unable to resolve zoned date/time");
  return result;
}

export function startOfBusinessDay(
  date: string,
  timeZone = OPERATIONAL_CONFIG.businessTimeZone,
): Date {
  const parts = calendarDateParts(date);
  return zonedDateTimeToUtc(parts, timeZone);
}

export function businessDayWindow(
  date: string,
  timeZone = OPERATIONAL_CONFIG.businessTimeZone,
): { start: Date; endExclusive: Date } {
  return {
    start: startOfBusinessDay(date, timeZone),
    endExclusive: startOfBusinessDay(addCalendarDays(date, 1), timeZone),
  };
}

export function parseTimestampInTimeZone(value: string, timeZone: string): Date {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Timestamp is required");
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const instant = new Date(trimmed);
    if (!Number.isFinite(instant.getTime())) throw new Error("Timestamp is invalid");
    return instant;
  }
  const match = ZONELESS_TIMESTAMP.exec(trimmed);
  if (!match) throw new Error("Timestamp must be ISO-like when no offset is supplied");
  return zonedDateTimeToUtc({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: Number(String(match[7] ?? "0").padEnd(3, "0")),
  }, timeZone);
}

export function parseBusinessTimestampCompatibility(value: string): Date {
  const trimmed = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) return parseTimestampInTimeZone(trimmed, OPERATIONAL_CONFIG.businessTimeZone);
  const match = ZONELESS_TIMESTAMP.exec(trimmed);
  if (!match) return parseTimestampInTimeZone(trimmed, OPERATIONAL_CONFIG.businessTimeZone);
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (date < OPERATIONAL_CONFIG.attendanceShiftTimezoneCutover) {
    const legacy = new Date(`${match[1]}-${match[2]}-${match[3]}T${String(match[4]).padStart(2, "0")}:${match[5]}:${match[6] ?? "00"}.${String(match[7] ?? "0").padEnd(3, "0")}-07:00`);
    if (!Number.isFinite(legacy.getTime())) throw new Error("Timestamp is invalid");
    return legacy;
  }
  return parseTimestampInTimeZone(trimmed, OPERATIONAL_CONFIG.businessTimeZone);
}

export function attendanceShiftStart(date: string, shiftValue: string | number): Date | null {
  const shift = typeof shiftValue === "number" ? shiftValue : Number.parseInt(shiftValue, 10);
  if (!Number.isSafeInteger(shift) || shift <= 0 || shift > 23) return null;
  if (date < OPERATIONAL_CONFIG.attendanceShiftTimezoneCutover) {
    return new Date(startOfBusinessDay(date).getTime() + (shift + 3) * 3_600_000);
  }
  const hour = shift <= 11 ? shift + 12 : shift;
  return zonedDateTimeToUtc({ ...calendarDateParts(date), hour }, OPERATIONAL_CONFIG.staffTimeZone);
}
