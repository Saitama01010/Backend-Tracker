export const DEFAULT_ATTENDANCE_TIMEZONE = "America/Los_Angeles";

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const configuredTimezone = process.env["ATTENDANCE_TIMEZONE"]?.trim() || DEFAULT_ATTENDANCE_TIMEZONE;
export const ATTENDANCE_TIMEZONE = validTimeZone(configuredTimezone)
  ? configuredTimezone
  : DEFAULT_ATTENDANCE_TIMEZONE;

export const ATTENDANCE_STATUSES = ["in", "off", "late", "pto", "absent", "nsnc"] as const;
export type AttendanceStatus = typeof ATTENDANCE_STATUSES[number];

export const ATTENDANCE_MEMBER_ALIASES: Record<string, string[]> = {
  "Levi Miller": ["Levi Miller", "Ahmed Ayman"],
  "Rick Miller": ["Rick Miller", "Zeiad Fouad"],
  "Jacob Stephenson": ["Jacob Stephenson", "Abdulrhman Isawi", "Adam Maxwell"],
  "Michael Belfort": ["Michael Belfort", "Nouralden"],
  "Ryan Henderson": ["Ryan Henderson", "Jacob Ahmed"],
  "Henry Hart": ["Henry Hart", "Max Francis"],
  "Jacob Xander": ["Jacob Xander", "Youssef Nady"],
  "John Marcus": ["John Marcus", "Youssef Nasser", "Youssef-John Marcus"],
};

export interface AttendanceMemberCandidate {
  id: number;
  name: string;
}

export type AttendanceMemberMatch =
  | { kind: "unique"; member: AttendanceMemberCandidate; matchedBy: "exact" | "alias" | "fuzzy" }
  | { kind: "ambiguous"; members: AttendanceMemberCandidate[] }
  | { kind: "missing" };

export function normalizeAttendanceName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function memberNames(member: AttendanceMemberCandidate): Array<{ value: string; alias: boolean }> {
  const configured = Object.entries(ATTENDANCE_MEMBER_ALIASES)
    .find(([canonical]) => normalizeAttendanceName(canonical) === normalizeAttendanceName(member.name))?.[1] ?? [];
  return [
    { value: member.name, alias: false },
    ...configured.filter((name) => normalizeAttendanceName(name) !== normalizeAttendanceName(member.name))
      .map((value) => ({ value, alias: true })),
  ];
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

export function resolveAttendanceMember(
  requestedName: string,
  members: AttendanceMemberCandidate[],
): AttendanceMemberMatch {
  const requested = normalizeAttendanceName(requestedName);
  if (!requested) return { kind: "missing" };

  const exact = members.flatMap((member) => memberNames(member)
    .filter(({ value }) => normalizeAttendanceName(value) === requested)
    .map(({ alias }) => ({ member, alias })));
  const exactMembers = [...new Map(exact.map((match) => [match.member.id, match])).values()];
  if (exactMembers.length === 1) {
    return {
      kind: "unique",
      member: exactMembers[0]!.member,
      matchedBy: exactMembers[0]!.alias ? "alias" : "exact",
    };
  }
  if (exactMembers.length > 1) return { kind: "ambiguous", members: exactMembers.map((item) => item.member) };

  const tokenMatches = members.filter((member) => memberNames(member).some(({ value }) => {
    const candidate = normalizeAttendanceName(value);
    return candidate.startsWith(`${requested} `) || candidate.endsWith(` ${requested}`);
  }));
  if (tokenMatches.length === 1) return { kind: "unique", member: tokenMatches[0]!, matchedBy: "fuzzy" };
  if (tokenMatches.length > 1) return { kind: "ambiguous", members: tokenMatches };

  if (requested.length < 4) return { kind: "missing" };
  const ranked = members.map((member) => ({
    member,
    distance: Math.min(...memberNames(member).map(({ value }) => levenshtein(requested, normalizeAttendanceName(value)))),
  })).sort((a, b) => a.distance - b.distance || a.member.name.localeCompare(b.member.name));
  const best = ranked[0];
  const maximumDistance = Math.max(1, Math.floor(requested.length * 0.18));
  if (!best || best.distance > maximumDistance) return { kind: "missing" };
  if (ranked[1] && ranked[1].distance <= best.distance + 1) {
    return { kind: "ambiguous", members: ranked.filter((item) => item.distance <= best.distance + 1).map((item) => item.member) };
  }
  return { kind: "unique", member: best.member, matchedBy: "fuzzy" };
}

function datePartsInTimezone(now: Date, timeZone = ATTENDANCE_TIMEZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: parts.weekday };
}

function isoFromParts(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function attendanceDate(now = new Date()): string {
  const parts = datePartsInTimezone(now);
  return isoFromParts(parts.year, parts.month, parts.day);
}

export function addAttendanceCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return isoFromParts(year!, month!, day! + days);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

export type AttendanceDateResolution =
  | { kind: "resolved"; date: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "invalid"; reason: string };

export function resolveAttendanceDate(value: string, now = new Date()): AttendanceDateResolution {
  const text = value.trim().toLowerCase().replace(/[,.]/g, " ").replace(/\s+/g, " ");
  const today = attendanceDate(now);
  if (!text || /\btoday\b/.test(text)) return { kind: "resolved", date: today };
  if (/\btomorrow\b/.test(text)) return { kind: "resolved", date: addAttendanceCalendarDays(today, 1) };

  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const date = isoFromParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    return date === isoMatch[0]
      ? { kind: "resolved", date }
      : { kind: "invalid", reason: "That calendar date is invalid." };
  }

  const monthMatch = text.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:\s+(\d{4}))?\b/);
  if (monthMatch) {
    const parts = datePartsInTimezone(now);
    const year = Number(monthMatch[3] ?? parts.year);
    const month = MONTHS[monthMatch[1]!]!;
    const day = Number(monthMatch[2]);
    const date = isoFromParts(year, month, day);
    const [actualYear, actualMonth, actualDay] = date.split("-").map(Number);
    return actualYear === year && actualMonth === month && actualDay === day
      ? { kind: "resolved", date }
      : { kind: "invalid", reason: "That calendar date is invalid." };
  }

  const weekday = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
  if (weekday >= 0) {
    const [year, month, day] = today.split("-").map(Number);
    const todayWeekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
    const delta = (weekday - todayWeekday + 7) % 7;
    if (delta === 0) {
      return { kind: "ambiguous", reason: `Do you mean today (${today}) or next ${WEEKDAYS[weekday]!.slice(0, 1).toUpperCase()}${WEEKDAYS[weekday]!.slice(1)}?` };
    }
    return { kind: "resolved", date: addAttendanceCalendarDays(today, delta) };
  }
  return { kind: "invalid", reason: `I could not resolve the attendance date in ${ATTENDANCE_TIMEZONE}.` };
}

export function attendanceStartOfDay(date: string, timeZone = ATTENDANCE_TIMEZONE): Date {
  const [year, month, day] = date.split("-").map(Number);
  const desiredWallTime = Date.UTC(year!, month! - 1, day!, 0, 0, 0);
  let instant = desiredWallTime;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const observed = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    instant += desiredWallTime - observed;
  }
  return new Date(instant);
}

export function formatAttendanceDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", year: "numeric", month: "long", day: "numeric",
  });
}

export type SamiaOperationalIntent =
  | { kind: "attendance_set"; requestedName: string; status: AttendanceStatus; dateText: string; overwrite: boolean; statement: boolean }
  | { kind: "attendance_note"; requestedName: string; note: string; dateText: string; overwrite: true }
  | { kind: "attendance_auto_mark"; dateText: string; confirmed: boolean }
  | { kind: "attendance_approval" }
  | { kind: "qa_run" }
  | { kind: "qa_evaluate_call"; callId: string }
  | { kind: "qa_resolve_task"; taskId: string }
  | null;

export function detectSamiaOperationalIntent(message: string): SamiaOperationalIntent {
  const text = message.trim().replace(/[’]/g, "'");
  const evaluate = text.match(/\b(?:re-?run|evaluate)\s+qa\s+(?:for\s+)?(?:this\s+)?call(?:\s+id)?\s*[:#]?\s*([A-Za-z0-9_-]{6,160})\b/i);
  if (evaluate) return { kind: "qa_evaluate_call", callId: evaluate[1]! };
  if (/\b(?:run|start)\s+(?:a\s+)?qa(?:\s+run)?\s*(?:now)?\b/i.test(text)) return { kind: "qa_run" };
  const resolve = text.match(/\bresolve\s+(?:this\s+)?(?:manager\s+)?qa\s+task\s*[:#]?\s*([A-Za-z0-9_-]{1,160})\b/i);
  if (resolve) return { kind: "qa_resolve_task", taskId: resolve[1]! };
  const autoMark = text.match(/^(?:auto[- ]?mark|run)\s+attendance(?:\s+(.*))?$/i);
  if (autoMark) {
    const suffix = autoMark[1]?.trim() || "today";
    return {
      kind: "attendance_auto_mark",
      dateText: suffix.replace(/\b(?:confirmed?|proceed)\b/gi, "").trim() || "today",
      confirmed: /\b(?:confirmed?|proceed)\b/i.test(suffix),
    };
  }

  if (/^(?:can|could|may|should|is it (?:ok|okay|possible)|do we have coverage)\b/i.test(text)
    && /\b(?:off|pto|absent|day off)\b/i.test(text)) return { kind: "attendance_approval" };

  const noteMatch = text.match(/^(?:add|set|update)\s+["“]([^"”]{1,500})["”]\s+(?:to|as)\s+(.+?)(?:'s)\s+attendance\s+note(?:\s+(.*))?$/i);
  if (noteMatch) {
    return {
      kind: "attendance_note",
      note: noteMatch[1]!.trim(),
      requestedName: noteMatch[2]!.trim(),
      dateText: noteMatch[3]?.trim() || "today",
      overwrite: true,
    };
  }

  const explicit = text.match(/^(mark|put|change|correct|update|replace|overwrite)\s+(.+?)\s+(?:attendance\s+)?(?:to\s+|as\s+|on\s+)?(in|off|pto|late|absent|nsnc)\b(?:\s+(?:on\s+|for\s+)?(.*))?$/i);
  if (explicit) {
    const verb = explicit[1]!.toLowerCase();
    const requestedName = explicit[2]!.replace(/(?:'s)?\s+attendance$/i, "").replace(/'s$/i, "").trim();
    return {
      kind: "attendance_set",
      requestedName,
      status: explicit[3]!.toLowerCase() as AttendanceStatus,
      dateText: explicit[4]?.trim() || "today",
      overwrite: ["change", "correct", "update", "replace", "overwrite"].includes(verb),
      statement: false,
    };
  }

  const statement = text.match(/^(.+?)\s+is\s+(in|off|pto|late|absent|nsnc)\b(?:\s+(?:on\s+|for\s+)?(.*))?$/i);
  if (statement) {
    return {
      kind: "attendance_set",
      requestedName: statement[1]!.trim(),
      status: statement[2]!.toLowerCase() as AttendanceStatus,
      dateText: statement[3]?.trim() || "today",
      overwrite: false,
      statement: true,
    };
  }
  return null;
}
