import type { Permission } from "@workspace/db/schema";
import type { AuthPayload } from "../middleware/auth.js";
import { recordActionAudit } from "./actionAudit.js";

export type SamiaCapabilityName =
  | "attendance_lookup_members"
  | "attendance_get_record"
  | "attendance_set_record"
  | "attendance_set_note"
  | "attendance_auto_mark"
  | "qa_run"
  | "qa_evaluate_call"
  | "qa_get_run_status"
  | "qa_resolve_manager_task"
  | "call_analysis"
  | "number_lookup"
  | "agent_contacts"
  | "dashboard_statistics";

type JsonSchema = {
  type: "object";
  additionalProperties: false;
  properties: Record<string, {
    type: "string" | "number" | "boolean" | "array";
    enum?: readonly string[];
    description?: string;
    items?: { type: "string" };
    minimum?: number;
    maximum?: number;
  }>;
  required: string[];
};

export interface CapabilityExecutionResult {
  ok: boolean;
  data?: unknown;
  reply?: string;
  mutations?: Array<Record<string, unknown>>;
  invalidateQueryKeys?: string[];
  error?: string;
  audit?: {
    targetResource: string;
    targetId?: string | number | null;
    previousValue?: unknown;
    newValue?: unknown;
  };
}

export interface CapabilityExecutionContext {
  user: AuthPayload;
  instructionRef?: string;
  executors: Partial<Record<SamiaCapabilityName, (input: Record<string, unknown>) => Promise<CapabilityExecutionResult>>>;
}

export interface SamiaCapabilityDefinition {
  name: SamiaCapabilityName;
  description: string;
  strictInputSchema: JsonSchema;
  requiredRole: "admin" | null;
  requiredPermission: Permission | null;
  classification: "read" | "write";
  executor: (input: Record<string, unknown>, context: CapabilityExecutionContext) => Promise<CapabilityExecutionResult>;
  auditBehavior: "none" | "write-attempt";
  invalidateQueryKeys: string[];
  confirmationRequired: boolean;
  targetResource: string;
}

const stringField = (description?: string) => ({ type: "string" as const, ...(description ? { description } : {}) });
const emptySchema = (): JsonSchema => ({ type: "object", additionalProperties: false, properties: {}, required: [] });
const schema = (properties: JsonSchema["properties"], required: string[] = []): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function fixedExecutor(name: SamiaCapabilityName) {
  return async (input: Record<string, unknown>, context: CapabilityExecutionContext) => {
    const executor = context.executors[name];
    if (!executor) throw new Error(`Server executor is unavailable for ${name}`);
    return executor(input);
  };
}

export const SAMIA_CAPABILITY_REGISTRY: Readonly<Record<SamiaCapabilityName, SamiaCapabilityDefinition>> = {
  attendance_lookup_members: {
    name: "attendance_lookup_members",
    description: "List active attendance members for deterministic server-side member resolution.",
    strictInputSchema: emptySchema(), requiredRole: null, requiredPermission: "view_attendance", classification: "read",
    executor: fixedExecutor("attendance_lookup_members"), auditBehavior: "none", invalidateQueryKeys: [], confirmationRequired: false, targetResource: "attendance_member",
  },
  attendance_get_record: {
    name: "attendance_get_record",
    description: "Read a member's persisted attendance record for one exact date in the configured attendance timezone.",
    strictInputSchema: schema({ memberId: { type: "number", minimum: 1 }, date: stringField("YYYY-MM-DD attendance date") }, ["memberId", "date"]),
    requiredRole: null, requiredPermission: "view_attendance", classification: "read", executor: fixedExecutor("attendance_get_record"),
    auditBehavior: "none", invalidateQueryKeys: [], confirmationRequired: false, targetResource: "attendance",
  },
  attendance_set_record: {
    name: "attendance_set_record",
    description: "Create or update one validated attendance record using a resolved member ID.",
    strictInputSchema: schema({
      memberId: { type: "number", minimum: 1 }, date: stringField("YYYY-MM-DD attendance date"),
      status: { type: "string", enum: ["in", "off", "late", "pto", "absent", "nsnc"] },
      note: stringField("Optional attendance note"), overwrite: { type: "boolean" },
    }, ["memberId", "date", "status", "overwrite"]),
    requiredRole: null, requiredPermission: "edit_attendance", classification: "write", executor: fixedExecutor("attendance_set_record"),
    auditBehavior: "write-attempt", invalidateQueryKeys: ["attendance", "attendance-call-logs"], confirmationRequired: false, targetResource: "attendance",
  },
  attendance_set_note: {
    name: "attendance_set_note",
    description: "Update the note on one existing attendance record using a resolved member ID.",
    strictInputSchema: schema({ memberId: { type: "number", minimum: 1 }, date: stringField(), note: stringField() }, ["memberId", "date", "note"]),
    requiredRole: null, requiredPermission: "edit_attendance", classification: "write", executor: fixedExecutor("attendance_set_note"),
    auditBehavior: "write-attempt", invalidateQueryKeys: ["attendance", "attendance-call-logs"], confirmationRequired: false, targetResource: "attendance",
  },
  attendance_auto_mark: {
    name: "attendance_auto_mark",
    description: "Auto-mark eligible attendance records for one exact date.",
    strictInputSchema: schema({ date: stringField("YYYY-MM-DD attendance date"), confirmed: { type: "boolean" } }, ["date", "confirmed"]),
    requiredRole: null, requiredPermission: "edit_attendance", classification: "write", executor: fixedExecutor("attendance_auto_mark"),
    auditBehavior: "write-attempt", invalidateQueryKeys: ["attendance", "attendance-call-logs"], confirmationRequired: true, targetResource: "attendance",
  },
  qa_run: {
    name: "qa_run", description: "Start the shared automatic QA service, or return the already-active run.", strictInputSchema: emptySchema(),
    requiredRole: "admin", requiredPermission: null, classification: "write", executor: fixedExecutor("qa_run"), auditBehavior: "write-attempt",
    invalidateQueryKeys: ["qa-stats", "qa-reviews", "qa-tasks", "qa-agents", "qa-runs"], confirmationRequired: false, targetResource: "qa_run",
  },
  qa_evaluate_call: {
    name: "qa_evaluate_call", description: "Evaluate one exact QUO call ID using the shared QA evaluator.",
    strictInputSchema: schema({ callId: stringField("Exact QUO call ID"), force: { type: "boolean" } }, ["callId", "force"]),
    requiredRole: "admin", requiredPermission: null, classification: "write", executor: fixedExecutor("qa_evaluate_call"), auditBehavior: "write-attempt",
    invalidateQueryKeys: ["qa-stats", "qa-reviews", "qa-tasks", "qa-agents", "qa-runs"], confirmationRequired: false, targetResource: "qa_review",
  },
  qa_get_run_status: {
    name: "qa_get_run_status", description: "Read the latest QA run status.", strictInputSchema: emptySchema(), requiredRole: "admin", requiredPermission: null,
    classification: "read", executor: fixedExecutor("qa_get_run_status"), auditBehavior: "none", invalidateQueryKeys: [], confirmationRequired: false, targetResource: "qa_run",
  },
  qa_resolve_manager_task: {
    name: "qa_resolve_manager_task", description: "Resolve one manager QA task by exact task ID.",
    strictInputSchema: schema({ taskId: stringField(), notes: stringField(), coachingComplete: { type: "boolean" } }, ["taskId", "coachingComplete"]),
    requiredRole: "admin", requiredPermission: null, classification: "write", executor: fixedExecutor("qa_resolve_manager_task"), auditBehavior: "write-attempt",
    invalidateQueryKeys: ["qa-stats", "qa-tasks", "qa-runs"], confirmationRequired: false, targetResource: "manager_qa_task",
  },
  call_analysis: {
    name: "call_analysis", description: "Read verified QUO summaries and transcripts for a bounded call-analysis request.",
    strictInputSchema: schema({ agent: stringField(), callId: stringField(), participant: stringField(), date: stringField(), limit: { type: "number", minimum: 1, maximum: 3 }, minSeconds: { type: "number", minimum: 0, maximum: 3600 } }),
    requiredRole: "admin", requiredPermission: null, classification: "read", executor: fixedExecutor("call_analysis"), auditBehavior: "none", invalidateQueryKeys: [], confirmationRequired: false, targetResource: "call",
  },
  number_lookup: {
    name: "number_lookup", description: "Read bounded call history for one normalized US phone number.",
    strictInputSchema: schema({ number: stringField(), sinceDays: { type: "number", minimum: 1, maximum: 365 } }, ["number"]),
    requiredRole: "admin", requiredPermission: null, classification: "read", executor: fixedExecutor("number_lookup"), auditBehavior: "none", invalidateQueryKeys: [], confirmationRequired: false, targetResource: "call",
  },
  agent_contacts: {
    name: "agent_contacts", description: "Read phone contacts for one agent and optional exact attendance date.",
    strictInputSchema: schema({ agentName: stringField(), date: stringField() }, ["agentName"]), requiredRole: "admin", requiredPermission: null,
    classification: "read", executor: fixedExecutor("agent_contacts"), auditBehavior: "none", invalidateQueryKeys: [], confirmationRequired: false, targetResource: "call",
  },
  dashboard_statistics: {
    name: "dashboard_statistics", description: "Read the authenticated dashboard statistics already assembled by the server.", strictInputSchema: emptySchema(),
    requiredRole: "admin", requiredPermission: null, classification: "read", executor: fixedExecutor("dashboard_statistics"), auditBehavior: "none",
    invalidateQueryKeys: [], confirmationRequired: false, targetResource: "dashboard",
  },
};

const FORBIDDEN_KEYS = /^(?:sql|query|route|path|url|command|shell|table|function|capability)$/i;
const SQL_TEXT = /\b(?:select|insert|update|delete|drop|alter|create|grant|revoke)\b[\s\S]{0,80}\b(?:from|into|table|database|schema|user)\b/i;

export function hasForbiddenCapabilityInput(value: unknown): boolean {
  if (typeof value === "string") return SQL_TEXT.test(value);
  if (Array.isArray(value)) return value.some(hasForbiddenCapabilityInput);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => FORBIDDEN_KEYS.test(key) || hasForbiddenCapabilityInput(item));
}

function validateInput(input: unknown, inputSchema: JsonSchema): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !(key in inputSchema.properties))) return false;
  if (inputSchema.required.some((key) => !(key in value))) return false;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const field = inputSchema.properties[key]!;
    if (field.type === "array") {
      if (!Array.isArray(item) || item.some((entry) => typeof entry !== field.items?.type)) return false;
    } else if (typeof item !== field.type) return false;
    if (field.enum && !field.enum.includes(item as string)) return false;
    if (typeof item === "number" && (item < (field.minimum ?? -Infinity) || item > (field.maximum ?? Infinity))) return false;
  }
  return true;
}

function authorized(definition: SamiaCapabilityDefinition, user: AuthPayload): boolean {
  if (definition.requiredRole === "admin" && user.role !== "admin") return false;
  if (definition.requiredPermission && !user.permissions.includes(definition.requiredPermission)) return false;
  return true;
}

export function capabilityTool(name: SamiaCapabilityName) {
  const definition = SAMIA_CAPABILITY_REGISTRY[name];
  // Anthropic strict tools currently reject numeric minimum/maximum keywords.
  // Keep those bounds in the server-owned registry validator, while exposing
  // only the provider-supported structural schema to Claude.
  const providerProperties = Object.fromEntries(Object.entries(definition.strictInputSchema.properties).map(([key, field]) => {
    const { minimum: _minimum, maximum: _maximum, ...providerField } = field;
    return [key, providerField];
  }));
  return {
    name: definition.name,
    description: definition.description,
    input_schema: { ...definition.strictInputSchema, properties: providerProperties },
    strict: true,
  };
}

export async function executeSamiaCapability(
  name: string,
  input: unknown,
  context: CapabilityExecutionContext,
): Promise<CapabilityExecutionResult> {
  const definition = SAMIA_CAPABILITY_REGISTRY[name as SamiaCapabilityName];
  if (!definition) throw new Error("Capability is not registered");

  try {
    if (!authorized(definition, context.user)) throw new Error("Capability is not authorized");
    if (!validateInput(input, definition.strictInputSchema)) throw new Error("Capability input failed strict validation");
    if (hasForbiddenCapabilityInput(input)) throw new Error("Capability input contains a forbidden control field");
    const result = await definition.executor(input, context);
    const invalidations = result.ok
      ? [...new Set([...(result.invalidateQueryKeys ?? []), ...definition.invalidateQueryKeys])]
      : [];
    if (definition.auditBehavior === "write-attempt") {
      await recordActionAudit({
        userId: context.user.userId,
        username: context.user.username,
        capabilityName: definition.name,
        targetResource: result.audit?.targetResource ?? definition.targetResource,
        targetId: result.audit?.targetId,
        previousValue: result.audit?.previousValue,
        newValue: result.audit?.newValue ?? input,
        success: result.ok,
        error: result.error,
        instructionRef: context.instructionRef,
      });
    }
    return { ...result, invalidateQueryKeys: invalidations };
  } catch (error) {
    if (definition.auditBehavior === "write-attempt") {
      await recordActionAudit({
        userId: context.user.userId,
        username: context.user.username,
        capabilityName: definition.name,
        targetResource: definition.targetResource,
        newValue: input,
        success: false,
        error: error instanceof Error ? error.message : "Capability execution failed",
        instructionRef: context.instructionRef,
      });
    }
    throw error;
  }
}
