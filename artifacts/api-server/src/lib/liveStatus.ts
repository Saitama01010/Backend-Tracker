export const LIVE_STATUS_FRESH_MS = 45_000;
export const LIVE_STATUS_MAX_STALE_MS = 2 * 60_000;

export type LiveStatusSource = {
  agentName: string;
  participant: string | null;
  observedAt: Date;
};

export type LiveStatusSnapshot = {
  active: string[];
  agentCalls: Array<{ agentName: string; participant: string | null }>;
  lastSuccessfulUpdateAt: Date | null;
  fresh: boolean;
  stale: boolean;
  usable: boolean;
};

/** Pure live-state merge used by the route and deterministic freshness tests. */
export function buildLiveStatusSnapshot(
  now: Date,
  sources: readonly LiveStatusSource[],
): LiveStatusSnapshot {
  const lastSuccessfulUpdateAt = sources.length > 0
    ? new Date(Math.max(...sources.map((source) => source.observedAt.getTime())))
    : null;
  const ageMs = lastSuccessfulUpdateAt
    ? now.getTime() - lastSuccessfulUpdateAt.getTime()
    : Number.POSITIVE_INFINITY;
  const stale = ageMs > LIVE_STATUS_FRESH_MS;
  const usable = ageMs <= LIVE_STATUS_MAX_STALE_MS;
  const active = new Set<string>();
  const participants = new Map<string, string | null>();
  if (usable) {
    for (const source of sources) {
      if (now.getTime() - source.observedAt.getTime() > LIVE_STATUS_MAX_STALE_MS) continue;
      active.add(source.agentName);
      if (source.participant) participants.set(source.agentName, source.participant);
      else if (!participants.has(source.agentName)) participants.set(source.agentName, null);
    }
  }
  return {
    active: [...active],
    agentCalls: [...participants.entries()].map(([agentName, participant]) => ({ agentName, participant })),
    lastSuccessfulUpdateAt,
    fresh: !stale,
    stale,
    usable,
  };
}

export function syntheticPollingDisplayDelayMs(sourceTimestampMs: number, pollingIntervalMs = 5_000): number {
  if (pollingIntervalMs <= 0) throw new Error("polling interval must be positive");
  return Math.ceil(sourceTimestampMs / pollingIntervalMs) * pollingIntervalMs - sourceTimestampMs;
}

/**
 * A terminal webhook must suppress an older polling/database observation for
 * the same agent, otherwise a completed call can be briefly resurrected.
 */
export function isSupersededLiveObservation(
  sourceObservedAt: Date,
  terminalObservedAt: Date | undefined,
): boolean {
  return terminalObservedAt !== undefined
    && terminalObservedAt.getTime() >= sourceObservedAt.getTime();
}
