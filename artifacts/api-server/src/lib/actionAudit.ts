import { actionAuditTable, db } from "@workspace/db";

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
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value as unknown[];
  if (typeof value === "object") return value as Record<string, unknown>;
  return { value };
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
    error: input.error?.slice(0, 500) ?? null,
    instructionRef: input.instructionRef?.slice(0, 200) ?? null,
  });
}
