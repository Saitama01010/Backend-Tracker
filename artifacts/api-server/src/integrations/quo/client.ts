import type { QuoCall, QuoPhoneNumber as QuoSyncPhoneNumber } from "./sync.js";

const QUO_BASE_URL = "https://api.openphone.com/v1";
const QUO_MIN_REQUEST_INTERVAL_MS = 400;
const QUO_MAX_RATE_LIMIT_RETRIES = 4;

let nextQuoRequestAt = 0;
let quoRequestGate: Promise<void> = Promise.resolve();

export interface QuoPhoneNumber {
  id: string;
  name: string;
  formattedNumber: string;
  number: string;
  users: { id: string; firstName: string; lastName: string; email: string }[];
}

export interface QuoApiUser {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
}

export interface QuoConversation {
  id: string;
  phoneNumberId: string;
  participants: string[];
}

export type QuoLiveCall = QuoCall & {
  users?: { id?: string; firstName?: string; lastName?: string; email?: string }[];
  userIds?: string[];
};

async function delayForQuo(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function quoHeaders(): Record<string, string> {
  const key = (process.env["QUO_API_KEY"] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!key) throw new Error("QUO_API_KEY not configured");
  return { Authorization: key, Accept: "application/json" };
}

async function waitForQuoRequestSlot(signal?: AbortSignal): Promise<void> {
  let release!: () => void;
  const previous = quoRequestGate;
  quoRequestGate = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    signal?.throwIfAborted();
    const waitMs = Math.max(0, nextQuoRequestAt - Date.now());
    if (waitMs > 0) await delayForQuo(waitMs, signal);
    nextQuoRequestAt = Date.now() + QUO_MIN_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

export async function fetchQuoJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const request = async () => {
    await waitForQuoRequestSlot(signal);
    return fetch(`${QUO_BASE_URL}${path}`, { headers: quoHeaders(), signal });
  };

  let response = await request();
  for (let attempt = 0; response.status === 429 && attempt < QUO_MAX_RATE_LIMIT_RETRIES; attempt++) {
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const dateDelay = retryAfter && !Number.isFinite(seconds)
      ? Date.parse(retryAfter) - Date.now()
      : Number.NaN;
    const providerDelay = Number.isFinite(seconds) ? seconds * 1_000 : dateDelay;
    const retryDelayMs = Number.isFinite(providerDelay)
      ? Math.min(30_000, Math.max(1_000, providerDelay))
      : Math.min(8_000, 1_000 * (2 ** attempt));
    await delayForQuo(retryDelayMs, signal);
    response = await request();
  }
  if (!response.ok) throw new Error(`Quo API error ${response.status}`);
  return response.json() as Promise<T>;
}

export async function fetchAllQuoPages<T>(basePath: string, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | null = null;
  let page = 0;
  do {
    const sep = basePath.includes("?") ? "&" : "?";
    const url: string = `${basePath}${sep}maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const response = await fetchQuoJson<{ data: T[]; nextPageToken?: string | null }>(url, signal);
    out.push(...(response.data ?? []));
    pageToken = response.nextPageToken ?? null;
    page++;
  } while (pageToken && page < 20);
  return out;
}

export async function fetchQuoPhoneNumbers(signal?: AbortSignal): Promise<QuoPhoneNumber[]> {
  const response = await fetchQuoJson<{ data: QuoPhoneNumber[] }>("/phone-numbers", signal);
  return response.data ?? [];
}

export async function fetchQuoLiveDirectory(signal?: AbortSignal): Promise<{
  users: QuoApiUser[];
  lines: QuoSyncPhoneNumber[];
}> {
  const [users, lines] = await Promise.all([
    fetchAllQuoPages<QuoApiUser>("/users", signal),
    fetchAllQuoPages<QuoSyncPhoneNumber>("/phone-numbers", signal),
  ]);
  return { users, lines };
}

export async function fetchQuoRecentConversations(
  updatedAfter: string,
  updatedBefore: string,
  signal?: AbortSignal,
): Promise<QuoConversation[]> {
  const response = await fetchQuoJson<{ data: QuoConversation[] }>(
    `/conversations?updatedAfter=${encodeURIComponent(updatedAfter)}&updatedBefore=${encodeURIComponent(updatedBefore)}&maxResults=100`,
    signal,
  );
  return response.data ?? [];
}

export async function fetchQuoConversationCalls(
  phoneNumberId: string,
  participant: string,
  createdAfter: string,
  createdBefore: string,
  signal?: AbortSignal,
): Promise<QuoLiveCall[]> {
  const response = await fetchQuoJson<{ data: QuoLiveCall[] }>(
    `/calls?phoneNumberId=${encodeURIComponent(phoneNumberId)}` +
    `&participants=${encodeURIComponent(participant)}` +
    `&createdAfter=${encodeURIComponent(createdAfter)}` +
    `&createdBefore=${encodeURIComponent(createdBefore)}` +
    `&maxResults=5`,
    signal,
  );
  return response.data ?? [];
}

export async function fetchQuoDirectoryPhoneNumbers(): Promise<string[]> {
  const key = process.env["QUO_API_KEY"];
  if (!key) return [];
  try {
    const response = await fetch(`${QUO_BASE_URL}/phone-numbers`, {
      headers: { Authorization: key, Accept: "application/json" },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data: { number?: string }[] };
    return (payload.data ?? [])
      .map((line) => line.number)
      .filter((number): number is string => Boolean(number));
  } catch {
    return [];
  }
}
