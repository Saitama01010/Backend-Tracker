const QUO_BASE_URL = "https://api.openphone.com/v1";

export interface QuoDialogueLine {
  identifier?: string;
  content?: string;
}

interface QuoTranscriptBody {
  data?: { dialogue?: QuoDialogueLine[]; status?: string };
}

export type QuoTranscriptResult =
  | { kind: "ok"; dialogue: QuoDialogueLine[]; status: string }
  | { kind: "notfound" }
  | { kind: "error" };

export interface QuoTranscriptRequestOptions {
  apiKey?: string;
  attempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Fetch a Quo transcript using the retry contract shared by onboarding and
 * live-transfer classification. A genuine 404 is terminal; throttling,
 * provider failures, network errors, and timeouts remain retryable so callers
 * do not persist a false no-transcript classification.
 */
export async function fetchQuoTranscript(
  callId: string,
  options: QuoTranscriptRequestOptions = {},
): Promise<QuoTranscriptResult> {
  const apiKey = options.apiKey ?? process.env["QUO_API_KEY"];
  if (!apiKey) throw new Error("QUO_API_KEY not configured");

  const attempts = options.attempts ?? 5;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const url = `${QUO_BASE_URL}/call-transcripts/${callId}`;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: apiKey, Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 404) return { kind: "notfound" };
      if (response.status === 429 || response.status >= 500) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      if (!response.ok) return { kind: "error" };
      const body = (await response.json()) as QuoTranscriptBody;
      return {
        kind: "ok",
        dialogue: body?.data?.dialogue ?? [],
        status: body?.data?.status ?? "none",
      };
    } catch {
      await sleep(1_500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  return { kind: "error" };
}
