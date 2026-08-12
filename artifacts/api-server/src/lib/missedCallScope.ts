import { businessDayWindow, formatCalendarDate } from "./businessTime.js";

export interface MissedCallScopeUser {
  role: string;
  teamAccess?: string | null;
  lockToToday?: boolean;
}

export interface MissedCallScopeItem {
  createdAt: string;
  team: string;
}

export function scopeMissedItemsForUser<T extends MissedCallScopeItem>(
  user: MissedCallScopeUser | undefined,
  items: readonly T[],
  now = new Date(),
): T[] {
  const teamScoped = user?.role === "admin" || !user?.teamAccess
    ? items
    : items.filter((item) => item.team === user.teamAccess);
  if (!user?.lockToToday || user.role === "admin") return [...teamScoped];
  const { start, endExclusive } = businessDayWindow(formatCalendarDate(now));
  return teamScoped.filter((item) => {
    const createdAt = Date.parse(item.createdAt);
    return Number.isFinite(createdAt) && createdAt >= start.getTime() && createdAt < endExclusive.getTime();
  });
}
