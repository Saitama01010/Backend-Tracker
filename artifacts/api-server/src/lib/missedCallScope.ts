import { businessDayWindow, formatCalendarDate } from "./businessTime.js";
import type { AuthPayload } from "../middleware/authCore.js";
import { canAccessFullTeam, isAdministrator, isCanonicalUser } from "../middleware/authorizationCore.js";

export type MissedCallScopeUser = AuthPayload;

export interface MissedCallScopeItem {
  createdAt: string;
  team: string;
}

export function scopeMissedItemsForUser<T extends MissedCallScopeItem>(
  user: MissedCallScopeUser | undefined,
  items: readonly T[],
  now = new Date(),
): T[] {
  const teamScoped = !user || isAdministrator(user)
    ? items
    : isCanonicalUser(user)
      ? items.filter((item) => (
          item.team === "retention" || item.team === "nsf" || item.team === "cs" || item.team === "killers"
        ) && canAccessFullTeam(user, item.team))
      : !user.teamAccess
        ? items
        : items.filter((item) => item.team === user.teamAccess);
  if (!user?.lockToToday || isAdministrator(user)) return [...teamScoped];
  const { start, endExclusive } = businessDayWindow(formatCalendarDate(now));
  return teamScoped.filter((item) => {
    const createdAt = Date.parse(item.createdAt);
    return (
      Number.isFinite(createdAt) &&
      createdAt >= start.getTime() &&
      createdAt < endExclusive.getTime()
    );
  });
}
