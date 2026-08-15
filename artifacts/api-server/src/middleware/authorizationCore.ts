import { CANONICAL_DASHBOARD_TABS, VALID_TEAMS } from "@workspace/db/schema";
import type { CanonicalDashboardTab, Permission, PrimaryTeamSlug, TeamSlug } from "@workspace/db/schema";
import type { AuthPayload } from "./authCore.js";
import { businessDayWindow, formatCalendarDate } from "../lib/businessTime.js";

export const DASHBOARD_TABS = CANONICAL_DASHBOARD_TABS;

export type DashboardTab = CanonicalDashboardTab;
export type MetricTeam = TeamSlug;

function isMetricTeam(team: PrimaryTeamSlug): team is MetricTeam {
  return (VALID_TEAMS as readonly string[]).includes(team);
}

const TAB_TO_METRIC_TEAM: Partial<Record<DashboardTab, MetricTeam>> = {
  retention: "retention",
  nsf: "nsf",
  cs: "cs",
  rmk: "killers",
};

export function hasPermission(user: AuthPayload, permission: Permission): boolean {
  return isAdministrator(user) || user.permissions.includes(permission);
}

export function hasAnyPermission(user: AuthPayload, permissions: readonly Permission[]): boolean {
  return isAdministrator(user) || permissions.some((permission) => user.permissions.includes(permission));
}

export function isCanonicalUser(user: AuthPayload): boolean {
  return user.accessModel === "canonical" || !!user.accessRole;
}

export function isAdministrator(user: AuthPayload): boolean {
  return isCanonicalUser(user) ? user.accessRole === "admin" : user.role === "admin";
}

/** Mirrors the current dashboard's canSeeTab implementation exactly. */
export function canViewTab(user: AuthPayload, tab: DashboardTab): boolean {
  if (tab === "backend-stats" && user.hideBackendStats) return false;
  if (isAdministrator(user)) return true;
  if (isCanonicalUser(user)) return !!user.allowedTabs?.includes(tab);

  const allowedTabs = user.allowedTabs;
  if (allowedTabs?.length) return allowedTabs.includes(tab);

  const team = user.teamAccess ?? null;
  const allTeams = team === null;
  if (tab === "backend-stats") return allTeams;
  if (tab === "violations" || tab === "callback-review") return allTeams;
  if (tab === "missed-no-cb") return true;
  if (tab === "retention") return allTeams || team === "retention";
  if (tab === "cs") return allTeams || team === "cs";
  if (tab === "nsf") return allTeams || team === "nsf";
  if (tab === "rmk" || tab === "onboarding") return allTeams;
  return false;
}

export function canViewAnyTab(user: AuthPayload, tabs: readonly DashboardTab[]): boolean {
  return tabs.some((tab) => canViewTab(user, tab));
}

export function canViewSubTab(user: AuthPayload, subTab: string): boolean {
  return isAdministrator(user) || !user.allowedSubTabs?.length || user.allowedSubTabs.includes(subTab);
}

export function normalizeAgentIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function canAccessAgent(
  user: AuthPayload,
  agentName: string,
  aliases: readonly string[] = [],
  canonical?: { id: number; team: MetricTeam },
): boolean {
  if (isAdministrator(user)) return true;
  if (isCanonicalUser(user)) {
    if (!canonical) return false;
    if (user.accessRole === "agent" && canonical.id === user.selfAgentId) return true;
    if (user.accessRole === "manager" && canonical.team === user.primaryTeam) return true;
    return !!user.fullTeamAccess?.includes(canonical.team);
  }
  if (!user.allowedAgents?.length) return true;
  const candidates = new Set([agentName, ...aliases].map(normalizeAgentIdentity).filter(Boolean));
  return user.allowedAgents.some((allowed) => candidates.has(normalizeAgentIdentity(allowed)));
}

export function metricTeamsForUser(user: AuthPayload): Set<MetricTeam> | null {
  if (isAdministrator(user)) return null;
  if (isCanonicalUser(user)) {
    const result = new Set<MetricTeam>(user.fullTeamAccess ?? []);
    if (user.accessRole === "agent" && user.selfAgentTeam) result.add(user.selfAgentTeam);
    if (user.accessRole === "manager" && user.primaryTeam && isMetricTeam(user.primaryTeam)) result.add(user.primaryTeam);
    return result;
  }
  const result = new Set<MetricTeam>();
  for (const tab of ["retention", "nsf", "cs", "rmk"] as const) {
    if (canViewTab(user, tab)) result.add(TAB_TO_METRIC_TEAM[tab]!);
  }
  return result;
}

export function canAccessMetricTeam(user: AuthPayload, team: MetricTeam): boolean {
  const teams = metricTeamsForUser(user);
  return teams === null || teams.has(team);
}

export function canAccessFullTeam(user: AuthPayload, team: MetricTeam): boolean {
  if (isAdministrator(user)) return true;
  if (isCanonicalUser(user)) {
    if (user.accessRole === "manager" && user.primaryTeam === team) return true;
    return !!user.fullTeamAccess?.includes(team);
  }
  return canAccessMetricTeam(user, team);
}

export function attendanceDepartmentForUser(user: AuthPayload): string | null {
  if (isAdministrator(user) || isCanonicalUser(user) || !user.teamAccess) return null;
  if (user.teamAccess === "retention") return "Retention";
  if (user.teamAccess === "nsf") return "NSF";
  return "CS";
}

export function canAccessAttendanceDepartment(user: AuthPayload, department: string): boolean {
  if (isCanonicalUser(user)) {
    const normalized = normalizeAgentIdentity(department);
    const team: MetricTeam | null = normalized === "retention"
      ? "retention"
      : normalized === "nsf"
        ? "nsf"
        : normalized === "cs" || normalized === "internal cs"
          ? "cs"
          : normalized === "killers" || normalized === "readymode killers" || normalized === "ready mode killers"
            ? "killers"
            : null;
    return team !== null && canAccessMetricTeam(user, team);
  }
  const allowed = attendanceDepartmentForUser(user);
  return allowed === null || normalizeAgentIdentity(allowed) === normalizeAgentIdentity(department);
}

export function todayInLosAngeles(now = new Date()): string {
  return formatCalendarDate(now);
}

function isTodayValue(value: string, today: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value === today;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;

  const { start, endExclusive } = businessDayWindow(today);
  return instant >= start.getTime() && instant < endExclusive.getTime();
}

export function canAccessDateRange(user: AuthPayload, values: readonly (string | undefined | null)[], now = new Date()): boolean {
  if (isAdministrator(user) || !user.lockToToday) return true;
  const requested = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (requested.length === 0) return false;
  const today = todayInLosAngeles(now);
  return requested.every((value) => isTodayValue(value.trim(), today));
}
