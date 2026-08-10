import type { Query } from "@tanstack/react-query";

export interface PollingPolicy<TData = unknown> {
  baseMs: number;
  authenticated?: boolean;
  active?: boolean;
  idleMs?: number;
  isIdle?: (data: TData | undefined) => boolean;
  visibilityState?: DocumentVisibilityState;
  online?: boolean;
}

function currentVisibility(): DocumentVisibilityState {
  return typeof document === "undefined" ? "visible" : document.visibilityState;
}

function currentOnlineState(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function pollingDelay<TData>({
  baseMs,
  authenticated = true,
  active = true,
  idleMs,
  isIdle,
  visibilityState = currentVisibility(),
  online = currentOnlineState(),
}: PollingPolicy<TData>, data?: TData): number | false {
  if (!authenticated || !active || visibilityState !== "visible" || !online) return false;
  if (idleMs && isIdle?.(data)) return Math.max(baseMs, idleMs);
  return baseMs;
}

export function queryPollingInterval<TData>(policy: PollingPolicy<TData>) {
  return (query: Query<TData, Error, TData, readonly unknown[]>): number | false =>
    pollingDelay(policy, query.state.data);
}

export function accountQueryScope(userId: number | string | null | undefined): string {
  return userId === null || userId === undefined ? "signed-out" : `user:${String(userId)}`;
}
