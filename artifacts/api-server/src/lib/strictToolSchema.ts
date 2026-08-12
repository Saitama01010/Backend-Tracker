export type StrictToolJsonSchema = {
  type: "object";
  additionalProperties: false;
  properties: Record<string, {
    type: "string" | "number" | "boolean" | "array";
    enum?: readonly string[];
    description?: string;
    items?: { type: "string" };
    minimum?: number;
    maximum?: number;
    integer?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    maxItems?: number;
    format?: "date" | "us-phone";
  }>;
  required: string[];
};

export function validateStrictToolInput(input: unknown, inputSchema: StrictToolJsonSchema): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !(key in inputSchema.properties))) return false;
  if (inputSchema.required.some((key) => !(key in value))) return false;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const field = inputSchema.properties[key]!;
    if (field.type === "array") {
      if (!Array.isArray(item) || item.length > (field.maxItems ?? Infinity) || item.some((entry) => typeof entry !== field.items?.type)) return false;
    } else if (typeof item !== field.type) return false;
    if (field.enum && !field.enum.includes(item as string)) return false;
    if (typeof item === "number" && (!Number.isFinite(item) || (field.integer === true && !Number.isInteger(item)) || item < (field.minimum ?? -Infinity) || item > (field.maximum ?? Infinity))) return false;
    if (typeof item === "string") {
      if (item.length < (field.minLength ?? 0) || item.length > (field.maxLength ?? Infinity)) return false;
      if (field.pattern && !new RegExp(field.pattern).test(item)) return false;
      if (field.format === "date") {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item);
        if (!match) return false;
        const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
        if (date.toISOString().slice(0, 10) !== item) return false;
      }
      if (field.format === "us-phone") {
        const digits = item.replace(/\D/g, "");
        if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith("1")))) return false;
      }
    }
  }
  return true;
}
