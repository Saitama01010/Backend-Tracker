import { db } from "@workspace/db";
import {
  ALL_PERMISSIONS,
  portalUsersTable,
  portalUserTabGrantsTable,
  portalUserTeamGrantsTable,
  teamAgentsTable,
  VALID_TEAMS,
} from "@workspace/db/schema";
import type {
  CanonicalDashboardTab,
  Permission,
  PrimaryTeamSlug,
  PortalUser,
  TeamAccess,
  TeamSlug,
} from "@workspace/db/schema";
import { eq, getTableColumns } from "drizzle-orm";
import type { AuthPayload, SessionAuthPayload } from "../middleware/authCore.js";

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

const PRIMARY_TEAM_TAB: Record<PrimaryTeamSlug, CanonicalDashboardTab> = {
  retention: "retention",
  nsf: "nsf",
  cs: "cs",
  killers: "rmk",
  onboarding: "onboarding",
};

function isMetricTeam(team: PrimaryTeamSlug): team is TeamSlug {
  return (VALID_TEAMS as readonly string[]).includes(team);
}

export interface ResolvedPortalAccess {
  user: PortalUser;
  payload: Omit<SessionAuthPayload, "sessionId">;
}

function legacyPayload(user: PortalUser): Omit<SessionAuthPayload, "sessionId"> {
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
    accessModel: "legacy",
    accessRole: null,
    selfAgentId: null,
    selfAgentName: null,
    selfAgentTeam: null,
    primaryTeam: null,
    fullTeamAccess: [],
    tabGrants: [],
  };
}

export function authPayloadForUser(user: PortalUser, sessionId: string): SessionAuthPayload {
  return { ...legacyPayload(user), sessionId };
}

export function authPayloadForAccess(
  access: ResolvedPortalAccess,
  sessionId: string,
): SessionAuthPayload {
  return { ...access.payload, sessionId };
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
    accessModel: payload.accessModel ?? "legacy",
    accessRole: payload.accessRole ?? null,
    selfAgentId: payload.selfAgentId ?? null,
    selfAgentName: payload.selfAgentName ?? null,
    selfAgentTeam: payload.selfAgentTeam ?? null,
    primaryTeam: payload.primaryTeam ?? null,
    fullTeamAccess: payload.fullTeamAccess ?? [],
    tabGrants: payload.tabGrants ?? [],
  };
}

export async function loadAuthenticatablePortalUser(userId: number): Promise<ResolvedPortalAccess | null> {
  const [row] = await db
    .select({
      ...getTableColumns(portalUsersTable),
      linkedAgentId: teamAgentsTable.id,
      linkedAgentName: teamAgentsTable.name,
      linkedAgentTeam: teamAgentsTable.team,
      linkedAgentActive: teamAgentsTable.active,
    })
    .from(portalUsersTable)
    .leftJoin(teamAgentsTable, eq(portalUsersTable.teamAgentId, teamAgentsTable.id))
    .where(eq(portalUsersTable.id, userId))
    .limit(1);
  if (!row?.active) return null;

  const user: PortalUser = row;
  if (!user.accessRole) return { user, payload: legacyPayload(user) };

  if (user.accessRole === "agent" && (
    !row.linkedAgentId
    || !row.linkedAgentName
    || !row.linkedAgentTeam
    || !row.linkedAgentActive
  )) return null;
  if (user.accessRole === "manager" && !user.primaryTeam) return null;

  const [teamGrantRows, tabGrantRows] = user.accessRole === "admin"
    ? [[], []] as const
    : await Promise.all([
        db.select({ team: portalUserTeamGrantsTable.team })
          .from(portalUserTeamGrantsTable)
          .where(eq(portalUserTeamGrantsTable.portalUserId, user.id)),
        db.select({ tab: portalUserTabGrantsTable.tab })
          .from(portalUserTabGrantsTable)
          .where(eq(portalUserTabGrantsTable.portalUserId, user.id)),
      ]);

  const grantedTeams = teamGrantRows.map(({ team }) => team);
  const managerMetricTeam = user.accessRole === "manager" && user.primaryTeam && isMetricTeam(user.primaryTeam)
    ? user.primaryTeam
    : null;
  const fullTeamAccess = user.accessRole === "manager"
    ? Array.from(new Set([...(managerMetricTeam ? [managerMetricTeam] : []), ...grantedTeams]))
    : grantedTeams;
  const coreTabs = user.accessRole === "agent"
    ? [PRIMARY_TEAM_TAB[row.linkedAgentTeam!]]
    : user.accessRole === "manager"
      ? [PRIMARY_TEAM_TAB[user.primaryTeam!]]
      : [];
  const tabGrants = tabGrantRows.map(({ tab }) => tab);
  const effectiveTabs = user.accessRole === "admin"
    ? null
    : Array.from(new Set([
        ...coreTabs,
        ...grantedTeams.map((team) => PRIMARY_TEAM_TAB[team]),
        ...tabGrants,
      ]));
  const storedPermissions = parsePermissions(user.permissions, user.accessRole === "admin" ? "admin" : user.role);
  const permissions = user.accessRole === "admin"
    ? [...ALL_PERMISSIONS]
    : Array.from(new Set<Permission>(["view_metrics", ...storedPermissions]));

  return {
    user,
    payload: {
      userId: user.id,
      username: user.username,
      role: user.accessRole === "admin" ? "admin" : "view",
      permissions,
      teamAccess: null,
      allowedTabs: effectiveTabs,
      allowedAgents: null,
      allowedSubTabs: parseJsonArray(user.allowedSubTabs),
      lockToToday: !!user.lockToToday,
      samiaCurse: !!user.samiaCurse,
      hideBackendStats: !!user.hideBackendStats,
      accessModel: "canonical",
      accessRole: user.accessRole,
      selfAgentId: row.linkedAgentId,
      selfAgentName: row.linkedAgentName,
      selfAgentTeam: row.linkedAgentTeam,
      primaryTeam: user.primaryTeam,
      fullTeamAccess,
      tabGrants,
    },
  };
}

export async function loadActivePortalUser(userId: number): Promise<PortalUser | null> {
  return (await loadAuthenticatablePortalUser(userId))?.user ?? null;
}
