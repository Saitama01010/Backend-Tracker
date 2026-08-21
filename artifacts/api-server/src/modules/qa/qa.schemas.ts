import { validateIntegrationDateRange } from "../../lib/externalIntegrationPolicy.js";
import { isSafeQuoCallId } from "../../lib/quoCall.js";
import { parseQaDateBasis, type QaDateBasis } from "../../lib/qaPolicy.js";

export type QaDepartment = "Retention" | "CS" | "NSF";

export type QaDepartmentSelection =
  | { ok: true; requested: QaDepartment | null }
  | { ok: false; error: "Invalid department." };

export function parseQaDepartment(value: unknown): QaDepartmentSelection {
  const normalized = String(value ?? "").trim().toLowerCase();
  const departments: Record<string, QaDepartment> = {
    retention: "Retention",
    cs: "CS",
    nsf: "NSF",
  };
  if (!normalized || normalized === "all") return { ok: true, requested: null };
  const requested = departments[normalized];
  return requested
    ? { ok: true, requested }
    : { ok: false, error: "Invalid department." };
}

export type QaRequestDateRange =
  | { ok: true; from: Date; to: Date }
  | { ok: false; error: string };

export function parseQaRequestDateRange(
  query: Record<string, unknown>,
  now = new Date(),
): QaRequestDateRange {
  const rawFrom = query["from"]
    ? String(query["from"])
    : new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  const rawTo = query["to"] ? String(query["to"]) : now.toISOString();
  const range = validateIntegrationDateRange(rawFrom, rawTo);
  return range.ok ? { ok: true, from: range.fromDate, to: range.toDate } : range;
}

export function parseQaDateBasisQuery(value: unknown):
  | { ok: true; dateBasis: QaDateBasis }
  | { ok: false; error: "dateBasis must be evaluated or call" } {
  const dateBasis = parseQaDateBasis(value);
  return dateBasis
    ? { ok: true, dateBasis }
    : { ok: false, error: "dateBasis must be evaluated or call" };
}

export type QaEvaluationRequest = {
  callId: string;
  force: boolean;
  rawIdempotencyKey: string | undefined;
};

export function parseQaEvaluationRequest(
  body: unknown,
  idempotencyKey: string | undefined,
): { ok: true; value: QaEvaluationRequest } | { ok: false; error: string } {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const callId = typeof input["callId"] === "string" ? input["callId"].trim() : "";
  if (!isSafeQuoCallId(callId)) return { ok: false, error: "A valid QUO callId is required" };

  const rawIdempotencyKey = idempotencyKey?.trim();
  if (rawIdempotencyKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(rawIdempotencyKey)) {
    return { ok: false, error: "Idempotency-Key is invalid" };
  }
  return {
    ok: true,
    value: {
      callId,
      force: input["force"] === true,
      rawIdempotencyKey,
    },
  };
}

export function parseQaListLimit(value: unknown): number {
  return Math.min(parseInt((value as string | undefined) ?? "100", 10) || 100, 500);
}

export type QaTaskResolutionInput = {
  notes: string | null;
  comments: string | null;
  coachingComplete: boolean;
  managerScore: number | null;
};

export function parseQaTaskResolution(body: unknown): QaTaskResolutionInput {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const managerScoreRaw = input["managerScore"];
  return {
    notes: String(input["notes"] ?? "").trim() || null,
    comments: String(input["comments"] ?? "").trim() || null,
    coachingComplete: Boolean(input["coachingComplete"]),
    managerScore: managerScoreRaw === undefined || managerScoreRaw === null || managerScoreRaw === ""
      ? null
      : Math.max(0, Math.min(100, Math.round(Number(managerScoreRaw)))),
  };
}
