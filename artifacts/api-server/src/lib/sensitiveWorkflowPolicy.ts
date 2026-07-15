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
    "Cache-Control": "private, no-store, max-age=0",
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
