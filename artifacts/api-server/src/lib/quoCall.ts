const QUO_BASE_URL = "https://api.openphone.com/v1";
const SAFE_QUO_CALL_ID = /^(?=.{8,128}$)(?=.*\d)[A-Za-z0-9_-]+$/;

export function isSafeQuoCallId(value: string): boolean {
  return SAFE_QUO_CALL_ID.test(value);
}
export function extractQuoCallId(message: string): string | null {
  const trimmed = message.trim();
  if (isSafeQuoCallId(trimmed)) return trimmed;

  const patterns = [
    /\banaly[sz]e\s+call\s+id\s*:\s*([A-Za-z0-9_-]{8,128})\b/i,
    /\blisten\s+to\s+this\s+call\s*:\s*([A-Za-z0-9_-]{8,128})\b/i,
    /\breview\s*:?[ \t]+([A-Za-z0-9_-]{8,128})\b/i,
  ];
  for (const pattern of patterns) {
    const candidate = pattern.exec(message)?.[1] ?? "";
    if (isSafeQuoCallId(candidate)) return candidate;
  }
  return null;
}

interface QuoFetchResult<T> {
  status: number;
  data: T | null;
}

async function fetchQuoJson<T>(path: string): Promise<QuoFetchResult<T>> {
  const apiKey = process.env["QUO_API_KEY"]?.trim();
  if (!apiKey) throw new Error("QUO_API_KEY is not set");
  const response = await fetch(`${QUO_BASE_URL}${path}`, {
    headers: { Authorization: apiKey },
  });
  if (!response.ok) return { status: response.status, data: null };
  return { status: response.status, data: await response.json() as T };
}

type SummaryResponse = {
  data?: { summary?: string[]; nextSteps?: string[]; status?: string };
};
type TranscriptResponse = {
  data?: {
    dialogue?: Array<{ identifier?: string; content?: string; start?: number; end?: number }>;
    status?: string;
  };
};

export interface QuoCallArtifacts {
  status: "ready" | "not_found" | "transcript_unavailable";
  transcriptStatus: string;
  summaryStatus: string;
  transcript: Array<{ speaker: string; text: string }>;
  transcriptText: string;
  summary: string[];
  nextSteps: string[];
}

export async function getQuoCallArtifacts(callId: string): Promise<QuoCallArtifacts> {
  if (!isSafeQuoCallId(callId)) {
    return {
      status: "not_found",
      transcriptStatus: "invalid",
      summaryStatus: "invalid",
      transcript: [],
      transcriptText: "",
      summary: [],
      nextSteps: [],
    };
  }
  const encoded = encodeURIComponent(callId);
  const [transcriptResult, summaryResult] = await Promise.all([
    fetchQuoJson<TranscriptResponse>(`/call-transcripts/${encoded}`),
    fetchQuoJson<SummaryResponse>(`/call-summaries/${encoded}`),
  ]);
  if (transcriptResult.status === 404 && summaryResult.status === 404) {
    return {
      status: "not_found",
      transcriptStatus: "not_found",
      summaryStatus: "not_found",
      transcript: [],
      transcriptText: "",
      summary: [],
      nextSteps: [],
    };
  }

  const transcript = (transcriptResult.data?.data?.dialogue ?? [])
    .map((line) => ({
      speaker: line.identifier?.trim() || "unknown",
      text: line.content?.trim() || "",
    }))
    .filter((line) => line.text.length > 0);
  const transcriptText = transcript.map((line) => `${line.speaker}: ${line.text}`).join("\n");
  const summary = (summaryResult.data?.data?.summary ?? []).filter((item) => typeof item === "string" && item.trim());
  const nextSteps = (summaryResult.data?.data?.nextSteps ?? []).filter((item) => typeof item === "string" && item.trim());

  return {
    status: transcriptText ? "ready" : "transcript_unavailable",
    transcriptStatus: transcriptResult.data?.data?.status ?? (transcriptResult.status === 404 ? "not_found" : "unavailable"),
    summaryStatus: summaryResult.data?.data?.status ?? (summaryResult.status === 404 ? "not_found" : "unavailable"),
    transcript,
    transcriptText,
    summary,
    nextSteps,
  };
}
