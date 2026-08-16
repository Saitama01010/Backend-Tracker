export interface RetentionQuoLiveWebhookCall {
  agentName: string;
  participant: string;
  ringingSince: Date;
}

// This process-local map remains the low-latency view only. Durable receipt,
// terminal-call persistence, polling, and database fallback stay authoritative.
export const retentionQuoLiveWebhookCalls = new Map<string, RetentionQuoLiveWebhookCall>();
