export function normalizePhone(num: string): string {
  const digits = (num ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function normalizeCustomerPhone(num: string): string {
  const raw = String(num ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function phoneComparisonKeys(num: string): string[] {
  const keys = new Set<string>();
  const last10 = normalizePhone(num);
  const e164 = normalizeCustomerPhone(num);
  if (last10) keys.add(last10);
  if (e164) keys.add(e164);
  return [...keys];
}

export function isPbxGhostCall(
  status: string,
  durationSeconds: number,
  ringDurationSeconds: number | null,
): boolean {
  if (ringDurationSeconds != null) return ringDurationSeconds <= 2;
  return (status === "no-answer" && durationSeconds === 0)
    || (status === "voicemail" && durationSeconds === 0)
    || (status === "voicemail-brief" && durationSeconds <= 4);
}

export const KNOWN_GHOST_NUMBERS = new Set([
  "2522688125",
  "9083338704",
  "2404861358",
  "9496103598",
  "4065646099",
  "3234400324",
  "5803517195",
  "2174146873",
  "4783875158",
  "6164605310",
  "9515524937",
  "9492351784",
  "8656432111",
  "5613693233",
  "4075088747",
  "4073401750",
  "8709958183",
  "7194692964",
]);
