import {
  getDurableRuntimeState,
  putDurableRuntimeState,
} from "./durableRuntimeState.js";
import { HIGH_FREQUENCY_MAX_DELAY_MINUTES } from "./backgroundSchedule.js";

const STATE_KEY = "scheduler:last-authenticated-invocation";
const STATE_TTL_MS = 45 * 24 * 60 * 60 * 1_000;

interface SchedulerHeartbeat extends Record<string, unknown> {
  invokedAt: string;
  scheduled: number;
  created: number;
  known: number;
}

export async function recordSchedulerHeartbeat(
  heartbeat: SchedulerHeartbeat,
): Promise<void> {
  await putDurableRuntimeState(STATE_KEY, heartbeat, STATE_TTL_MS);
}

export async function schedulerHealth(now = new Date()): Promise<{
  lastInvocationAt: string | null;
  ageSeconds: number | null;
  highFrequencyStale: boolean;
  maximumDelayMinutes: number;
}> {
  const state = await getDurableRuntimeState<SchedulerHeartbeat>(
    STATE_KEY,
    now,
  );
  const lastInvocationAt = state?.value.invokedAt ?? null;
  const ageSeconds = lastInvocationAt
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - new Date(lastInvocationAt).getTime()) / 1_000,
        ),
      )
    : null;
  return {
    lastInvocationAt,
    ageSeconds,
    highFrequencyStale:
      ageSeconds === null || ageSeconds > HIGH_FREQUENCY_MAX_DELAY_MINUTES * 60,
    maximumDelayMinutes: HIGH_FREQUENCY_MAX_DELAY_MINUTES,
  };
}
