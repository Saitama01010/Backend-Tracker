const QUO_BASE_URL = "https://api.openphone.com/v1";
const QUO_MIN_REQUEST_INTERVAL_MS = 400;
const QUO_MAX_RATE_LIMIT_RETRIES = 4;

let nextQuoRequestAt = 0;
let quoRequestGate: Promise<void> = Promise.resolve();

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
