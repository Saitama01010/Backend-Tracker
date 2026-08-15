import { createContext, useContext } from "react";

export type Permission = "view_metrics" | "view_attendance" | "edit_attendance" | "manage_members" | "view_missed_tables";
export type TeamAccess = "retention" | "nsf" | "cs";
export type CanonicalAccessRole = "agent" | "manager" | "admin";
export type CanonicalTeam = TeamAccess | "killers";
export type CanonicalPrimaryTeam = CanonicalTeam | "onboarding";

export interface AuthUser {
  id: number;
  username: string;
  role: "admin" | "edit" | "view";
  permissions: Permission[];
  teamAccess?: TeamAccess | null;
  allowedTabs?: string[] | null;
  allowedAgents?: string[] | null;
  allowedSubTabs?: string[] | null;
  lockToToday?: boolean;
  hideBackendStats?: boolean;
  accessModel?: "legacy" | "canonical";
  accessRole?: CanonicalAccessRole | null;
  selfAgentId?: number | null;
  selfAgentName?: string | null;
  selfAgentTeam?: CanonicalTeam | null;
  primaryTeam?: CanonicalPrimaryTeam | null;
  fullTeamAccess?: CanonicalTeam[];
  tabGrants?: string[];
}

export interface AuthCtx {
  user: AuthUser;
  token: string;
  logout: () => void;
  can: (permission: Permission) => boolean;
  canSeeTab: (tab: string) => boolean;
}

export const UserContext = createContext<AuthCtx | null>(null);

export function useUser(): AuthCtx {
  const context = useContext(UserContext);
  if (!context) throw new Error("useUser must be used inside LoginGate");
  return context;
}

export function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

export function canUserSeeTab(user: AuthUser, tab: string): boolean {
  if (tab === "backend-stats" && user.hideBackendStats) return false;
  if (user.role === "admin") return true;
  if (user.allowedTabs?.length) return user.allowedTabs.includes(tab);

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
