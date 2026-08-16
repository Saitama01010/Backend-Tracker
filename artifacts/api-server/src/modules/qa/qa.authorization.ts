import { canAccessMetricAgent, loadAuthorizationAgentDirectory } from "../../lib/authorizationScope.js";
import type { AuthPayload } from "../../middleware/authCore.js";
import {
  isAdministrator,
  isCanonicalUser,
  metricTeamsForUser,
  normalizeAgentIdentity,
} from "../../middleware/authorizationCore.js";
import type { QaDepartment } from "./qa.schemas.js";

export type QaDepartmentScope =
  | { ok: true; departments: QaDepartment[] | null }
  | { ok: false; status: 403; error: "Forbidden" };

export function authorizeQaDepartments(
  user: AuthPayload,
  requested: QaDepartment | null,
): QaDepartmentScope {
  if (isCanonicalUser(user)) {
    if (isAdministrator(user)) return { ok: true, departments: requested ? [requested] : null };
    const allowedTeams = metricTeamsForUser(user) ?? new Set();
    const teamForDepartment: Record<QaDepartment, "retention" | "cs" | "nsf"> = {
      Retention: "retention",
      CS: "cs",
      NSF: "nsf",
    };
    if (requested && !allowedTeams.has(teamForDepartment[requested])) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    const departments = requested
      ? [requested]
      : (Object.keys(teamForDepartment) as QaDepartment[]).filter((department) =>
          allowedTeams.has(teamForDepartment[department]));
    return { ok: true, departments };
  }

  const team = user.role === "admin" ? null : user.teamAccess;
  const allowed = team === "retention" ? "Retention" : team === "cs" ? "CS" : team === "nsf" ? "NSF" : null;
  if (team && !allowed) return { ok: false, status: 403, error: "Forbidden" };
  if (allowed && requested && requested !== allowed) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, departments: requested ? [requested] : allowed ? [allowed] : null };
}

export type QaAgentScope = {
  canAccess: (agentName: string) => boolean;
  authorizedIdentities: string[] | null;
};

export async function resolveQaAgentScope(user: AuthPayload): Promise<QaAgentScope> {
  if (isAdministrator(user) || (!isCanonicalUser(user) && !user.allowedAgents?.length)) {
    return { canAccess: () => true, authorizedIdentities: null };
  }
  const directory = await loadAuthorizationAgentDirectory();
  const canAccess = (agentName: string) => canAccessMetricAgent(user, agentName, directory);
  const authorizedIdentities = new Set(
    isCanonicalUser(user) ? [] : (user.allowedAgents ?? []).map(normalizeAgentIdentity).filter(Boolean),
  );
  for (const agent of directory.agents) {
    if (!canAccess(agent.name)) continue;
    authorizedIdentities.add(normalizeAgentIdentity(agent.name));
    if (agent.arabicName) authorizedIdentities.add(normalizeAgentIdentity(agent.arabicName));
  }
  return { canAccess, authorizedIdentities: [...authorizedIdentities].filter(Boolean) };
}
