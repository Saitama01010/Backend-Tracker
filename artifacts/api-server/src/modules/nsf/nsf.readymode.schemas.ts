export type ParsedQueueNumbers =
  | { ok: true; value: string[] }
  | { ok: false; error: "No valid 10-digit numbers provided." };

export function normalizeNsfReadymodePhone(value: string): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function formatNsfReadymodePhone(value: string): string {
  const digits = normalizeNsfReadymodePhone(value);
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value;
}

export function parseNsfReadymodeNumbers(value: unknown): ParsedQueueNumbers {
  const raw = Array.isArray(value) ? value : [];
  const numbers = Array.from(
    new Set(
      raw
        .map((number) => (typeof number === "string" ? normalizeNsfReadymodePhone(number) : ""))
        .filter((number) => number.length === 10),
    ),
  );
  return numbers.length > 0
    ? { ok: true, value: numbers }
    : { ok: false, error: "No valid 10-digit numbers provided." };
}

export function resolveNsfReadymodeActor(
  value: unknown,
  username: string | undefined,
  fallback: string,
): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : (username ?? fallback);
}

export function parseNsfReadymodeId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseNsfReadymodeDoneNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const number = normalizeNsfReadymodePhone(value);
  return number.length === 10 ? number : null;
}
