import { actionAuditTable, db } from "@workspace/db";
import { sanitizeAiAuditValue } from "./aiPrivacy.js";

export interface ActionAuditInput {
  userId: number;
  username: string;
  capabilityName: string;
  targetResource: string;
  targetId?: string | number | null;
  previousValue?: unknown;
  newValue?: unknown;
  success: boolean;
  error?: string | null;
  instructionRef?: string | null;
}

function jsonValue(value: unknown): Record<string, unknown> | unknown[] | null {
  const sanitized = sanitizeAiAuditValue(value);
  if (sanitized === undefined || sanitized === null) return null;
  if (Array.isArray(sanitized)) return sanitized;
  if (typeof sanitized === "object") return sanitized as Record<string, unknown>;
  return { value: sanitized };
}

export async function recordActionAudit(input: ActionAuditInput): Promise<void> {
  await db.insert(actionAuditTable).values({
    userId: input.userId,
    username: input.username.slice(0, 200),
    source: "samia",
    capabilityName: input.capabilityName.slice(0, 120),
    targetResource: input.targetResource.slice(0, 120),
    targetId: input.targetId === undefined || input.targetId === null ? null : String(input.targetId).slice(0, 300),
    previousValue: jsonValue(input.previousValue),
    newValue: jsonValue(input.newValue),
    success: input.success,
    error: input.error ? "AI_ACTION_FAILED" : null,
    instructionRef: input.instructionRef?.slice(0, 200) ?? null,
  });
}
