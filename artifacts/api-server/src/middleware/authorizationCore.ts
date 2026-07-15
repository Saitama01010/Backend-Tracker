import type { Permission } from "@workspace/db/schema";
import type { AuthPayload } from "./authCore.js";

export const DASHBOARD_TABS = [
  "backend-stats",
  "retention",
  "cs",
  "nsf",
  "rmk",
  "missed-no-cb",
  "callback-review",
  "violations",
  "qa",
  "onboarding",
] as const;

export type DashboardTab = typeof DASHBOARD_TABS[number];
export type MetricTeam = "retention" | "nsf" | "cs" | "killers";

const TAB_TO_METRIC_TEAM: Partial<Record<DashboardTab, MetricTeam>> = {
  retention: "retention",
  nsf: "nsf",
  cs: "cs",
  rmk: "killers",
};

export function hasPermission(user: AuthPayload, permission: Permission): boolean {
  return user.role === "admin" || user.permissions.includes(permission);
}

export function hasAnyPermission(user: AuthPayload, permissions: readonly Permission[]): boolean {
  return user.role === "admin" || permissions.some((permission) => user.permissions.includes(permission));
}

/** Mirrors the current dashboard's canSeeTab implementation exactly. */
export function canViewTab(user: AuthPayload, tab: DashboardTab): boolean {
  if (tab === "backend-stats" && user.hideBackendStats) return false;
  if (user.role === "admin") return true;

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
  return user.role === "admin" || !user.allowedSubTabs?.length || user.allowedSubTabs.includes(subTab);
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

export function canAccessAgent(user: AuthPayload, agentName: string, aliases: readonly string[] = []): boolean {
  if (user.role === "admin" || !user.allowedAgents?.length) return true;
  const candidates = new Set([agentName, ...aliases].map(normalizeAgentIdentity).filter(Boolean));
  return user.allowedAgents.some((allowed) => candidates.has(normalizeAgentIdentity(allowed)));
}

export function metricTeamsForUser(user: AuthPayload): Set<MetricTeam> | null {
  if (user.role === "admin") return null;
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

export function attendanceDepartmentForUser(user: AuthPayload): string | null {
  if (user.role === "admin" || !user.teamAccess) return null;
  if (user.teamAccess === "retention") return "Retention";
  if (user.teamAccess === "nsf") return "NSF";
  return "CS";
}

export function canAccessAttendanceDepartment(user: AuthPayload, department: string): boolean {
  const allowed = attendanceDepartmentForUser(user);
  return allowed === null || normalizeAgentIdentity(allowed) === normalizeAgentIdentity(department);
}

export function todayInLosAngeles(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function losAngelesDayBounds(date: string): { from: number; to: number } {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "longOffset",
  }).formatToParts(noonUtc);
  const offset = offsetParts.find((part) => part.type === "timeZoneName")?.value.match(/GMT([+-])(\d{2}):(\d{2})/);
  const sign = offset?.[1] === "-" ? -1 : 1;
  const offsetMinutes = offset ? sign * (Number(offset[2]) * 60 + Number(offset[3])) : -8 * 60;
  const from = Date.parse(`${date}T00:00:00Z`) - offsetMinutes * 60_000;
  return { from, to: from + 24 * 60 * 60_000 };
}

function isTodayValue(value: string, today: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value === today;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;

  const bounds = losAngelesDayBounds(today);
  // The dashboard serializes a selected calendar day through the browser's
  // local timezone. Accept the current calendar day in every valid civil
  // timezone, but reject prior/future calendar days.
  const earliestCivilStart = bounds.from - 14 * 60 * 60_000;
  const latestCivilEnd = bounds.to + 12 * 60 * 60_000;
  return instant >= earliestCivilStart && instant < latestCivilEnd;
}

export function canAccessDateRange(user: AuthPayload, values: readonly (string | undefined | null)[], now = new Date()): boolean {
  if (user.role === "admin" || !user.lockToToday) return true;
  const requested = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (requested.length === 0) return false;
  const today = todayInLosAngeles(now);
  return requested.every((value) => isTodayValue(value.trim(), today));
}
