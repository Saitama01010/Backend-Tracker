import { createContext, useContext } from "react";

export type Permission = "view_metrics" | "view_attendance" | "edit_attendance" | "manage_members" | "view_missed_tables";
export type TeamAccess = "retention" | "nsf" | "cs";
export type CanonicalAccessRole = "agent" | "manager" | "admin";
export type CanonicalTeam = TeamAccess | "killers";

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
  primaryTeam?: CanonicalTeam | null;
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
