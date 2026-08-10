import { db } from "@workspace/db";
import { ALL_PERMISSIONS, portalUsersTable } from "@workspace/db/schema";
import type { Permission, PortalUser, TeamAccess } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { AuthPayload } from "../middleware/authCore.js";

function parsePermissions(raw: string | null | undefined, role: string): Permission[] {
  if (role === "admin") return [...ALL_PERMISSIONS];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((permission): permission is Permission =>
        typeof permission === "string" && (ALL_PERMISSIONS as readonly string[]).includes(permission))
      : [];
  } catch {
    return [];
  }
}

function parseJsonArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
    return values.length > 0 ? values : null;
  } catch {
    return null;
  }
}

function parseTeamAccess(raw: string | null | undefined): TeamAccess | null {
  return raw === "retention" || raw === "nsf" || raw === "cs" ? raw : null;
}

export function authPayloadForUser(user: PortalUser, sessionId?: string): AuthPayload {
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    permissions: parsePermissions(user.permissions, user.role),
    teamAccess: parseTeamAccess(user.teamAccess),
    allowedTabs: parseJsonArray(user.allowedTabs),
    allowedAgents: parseJsonArray(user.allowedAgents),
    allowedSubTabs: parseJsonArray(user.allowedSubTabs),
    lockToToday: !!user.lockToToday,
    samiaCurse: !!user.samiaCurse,
    hideBackendStats: !!user.hideBackendStats,
    ...(sessionId ? { sessionId } : {}),
  };
}

export function publicAuthUser(payload: AuthPayload) {
  return {
    id: payload.userId,
    username: payload.username,
    role: payload.role,
    permissions: payload.permissions,
    teamAccess: payload.teamAccess ?? null,
    allowedTabs: payload.allowedTabs ?? null,
    allowedAgents: payload.allowedAgents ?? null,
    allowedSubTabs: payload.allowedSubTabs ?? null,
    lockToToday: !!payload.lockToToday,
    hideBackendStats: !!payload.hideBackendStats,
  };
}

export async function loadActivePortalUser(userId: number): Promise<PortalUser | null> {
  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, userId))
    .limit(1);
  return user?.active ? user : null;
}
