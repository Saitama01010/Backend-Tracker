import {
  MAX_INTEGRATION_READ_DAYS,
  validateIntegrationCalendarDate,
  validateIntegrationDateRange,
  type ValidatedIntegrationRange,
} from "./externalIntegrationPolicy.js";

const PRIVATE_WORKBOOK_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ALLOWED_VIOLATION_TYPES = new Set([
  "late_login",
  "availability_gap",
  "missed_call",
  "unauthorized_cancel",
]);

export type OptionalWorkflowRange =
  | { ok: true; range: Extract<ValidatedIntegrationRange, { ok: true }> | null }
  | { ok: false; error: string };

export function validateWorkflowCalendarDate(value: unknown): value is string {
  return validateIntegrationCalendarDate(value);
}

export function validateOptionalWorkflowRange(
  from: unknown,
  to: unknown,
  maxDays = MAX_INTEGRATION_READ_DAYS,
): OptionalWorkflowRange {
  const hasFrom = from !== undefined && from !== null && from !== "";
  const hasTo = to !== undefined && to !== null && to !== "";
  if (!hasFrom && !hasTo) return { ok: true, range: null };
  if (!hasFrom || !hasTo) return { ok: false, error: "Both from and to are required." };
  if (!validateWorkflowCalendarDate(from) || !validateWorkflowCalendarDate(to)) {
    return { ok: false, error: "Invalid date range." };
  }
  const range = validateIntegrationDateRange(from, to, maxDays);
  return range.ok ? { ok: true, range } : range;
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

type HeaderWriter = { setHeader(name: string, value: string): unknown };

export function privateDownloadHeaders(filename: string): Record<string, string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) throw new Error("Invalid download filename.");
  return {
    "Content-Type": PRIVATE_WORKBOOK_CONTENT_TYPE,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store, max-age=0, no-transform",
    Pragma: "no-cache",
    Expires: "0",
    "X-Content-Type-Options": "nosniff",
  };
}

export function setPrivateDownloadHeaders(response: HeaderWriter, filename: string): void {
  for (const [name, value] of Object.entries(privateDownloadHeaders(filename))) {
    response.setHeader(name, value);
  }
}

export type ViolationVerificationPayload = {
  key: string;
  type: string;
  member: string;
  department: string;
  date: string;
  details: string;
  verifiedBy: string;
};

function parsedViolationDetails(payload: ViolationVerificationPayload): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload.details);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizedKeyIdentity(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function violationVerificationKeyMatchesPayload(
  payload: ViolationVerificationPayload,
  memberAliases: readonly string[] = [],
): boolean {
  if (payload.type === "late_login") return payload.key === `late:${payload.member}:${payload.date}`;
  if (payload.type === "availability_gap") return payload.key === `gap:${payload.member}:${payload.date}`;

  const details = parsedViolationDetails(payload);
  if (!details || details["key"] !== payload.key || details["date"] !== payload.date) return false;

  if (payload.type === "missed_call") {
    const availableAgents = details["availableAgents"];
    return /^(?:missed:\d+|quo-missed:[A-Za-z0-9._:-]{1,200})$/.test(payload.key)
      && typeof details["team"] === "string"
      && normalizedKeyIdentity(details["team"]) === normalizedKeyIdentity(payload.department)
      && Array.isArray(availableAgents)
      && availableAgents.includes(payload.member);
  }

  if (payload.type === "unauthorized_cancel") {
    if (details["agent"] !== payload.member
      || typeof details["team"] !== "string"
      || normalizedKeyIdentity(details["team"]) !== normalizedKeyIdentity(payload.department)
      || typeof details["fileId"] !== "string") return false;
    const match = /^cancel:(old|new):(.+):(\d{4}-\d{2}-\d{2}):(.*)$/.exec(payload.key);
    if (!match || match[3] !== payload.date || match[4] !== details["fileId"]) return false;
    const allowedIdentities = new Set([payload.member, ...memberAliases].map(normalizedKeyIdentity));
    return allowedIdentities.has(normalizedKeyIdentity(match[2]!));
  }

  return false;
}

function boundedText(value: unknown, maximum: number, required = true): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) return null;
  return normalized;
}

export function parseViolationVerificationPayload(
  input: unknown,
  authenticatedActor: string,
): ViolationVerificationPayload | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const key = boundedText(body["key"], 512);
  const type = boundedText(body["type"], 64);
  const member = boundedText(body["member"], 200);
  const department = boundedText(body["department"], 100, false);
  const date = boundedText(body["date"], 10);
  const actor = boundedText(authenticatedActor, 200);
  if (!key || !type || !ALLOWED_VIOLATION_TYPES.has(type) || !member || department === null || !date || !actor) {
    return null;
  }
  if (!validateWorkflowCalendarDate(date)) return null;

  const rawDetails = body["details"] ?? "{}";
  let details: string;
  if (typeof rawDetails === "string") {
    details = rawDetails;
  } else {
    try {
      details = JSON.stringify(rawDetails);
    } catch {
      return null;
    }
  }
  if (details.length > 32_768) return null;
  try {
    const parsed = JSON.parse(details);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }

  return { key, type, member, department, date, details, verifiedBy: actor };
}
