import bcrypt from "bcryptjs";
import { isValidAgentEmail, normalizeAgentEmail } from "@workspace/api-zod/agent-identity";
import {
  ALL_PERMISSIONS,
  CANONICAL_ACCESS_ROLES,
  CANONICAL_DASHBOARD_TABS,
  VALID_PRIMARY_TEAMS,
  VALID_TEAMS,
  type CanonicalAccessRole,
  type CanonicalDashboardTab,
  type Permission,
  type PrimaryTeamSlug,
  type TeamSlug,
} from "@workspace/db/schema";
import { CURRENT_PASSWORD_POLICY_VERSION, validateNewPassword } from "../../lib/passwordPolicy.js";
import {
  usersRepository,
  type PortalUserGrantUpdate,
  type PortalUserUpdates,
  type UsersRepository,
} from "./users.repository.js";

export class UserRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type CanonicalInput = {
  accessRole: CanonicalAccessRole;
  teamAgentId: number | null;
  primaryTeam: PrimaryTeamSlug | null;
  teamGrants: TeamSlug[];
  tabGrants: CanonicalDashboardTab[];
  permissions: Permission[];
  compatibilityRole: "admin" | "view";
  rosterEmailNormalized: string | null;
};

function requestBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new UserRequestError(400, "Invalid id");
  return id;
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new UserRequestError(400, "Username is required");
  return value.trim().toLowerCase();
}

function portalUserEmailIdentity(
  value: unknown,
  options: { required?: boolean } = {},
): { email: string | null; emailNormalized: string | null } {
  if (value == null || (typeof value === "string" && !value.trim())) {
    if (options.required) throw new UserRequestError(400, "Email is required");
    return { email: null, emailNormalized: null };
  }
  if (typeof value !== "string" || !isValidAgentEmail(value)) {
    throw new UserRequestError(400, "Enter a valid email address");
  }
  return { email: value.trim(), emailNormalized: normalizeAgentEmail(value) };
}

function parsePermissions(value: unknown, includeCoreMetrics: boolean): Permission[] {
  if (!Array.isArray(value)) {
    if (value === undefined) return includeCoreMetrics ? ["view_metrics"] : [];
    throw new UserRequestError(400, "Permissions must be an array");
  }
  const permissions = value.filter((item): item is Permission =>
    typeof item === "string" && (ALL_PERMISSIONS as readonly string[]).includes(item));
  if (permissions.length !== value.length) throw new UserRequestError(400, "Invalid permission");
  return Array.from(new Set(includeCoreMetrics ? ["view_metrics", ...permissions] : permissions));
}

function parseStringGrantList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new UserRequestError(400, `${field} must be an array`);
  const parsed = value.filter((item): item is T =>
    typeof item === "string" && (allowed as readonly string[]).includes(item));
  if (parsed.length !== value.length) throw new UserRequestError(400, `Invalid ${field} value`);
  return Array.from(new Set(parsed));
}

function isAccessRole(value: unknown): value is CanonicalAccessRole {
  return typeof value === "string" && (CANONICAL_ACCESS_ROLES as readonly string[]).includes(value);
}

function isTeam(value: unknown): value is TeamSlug {
  return typeof value === "string" && (VALID_TEAMS as readonly string[]).includes(value);
}

function isPrimaryTeam(value: unknown): value is PrimaryTeamSlug {
  return typeof value === "string" && (VALID_PRIMARY_TEAMS as readonly string[]).includes(value);
}

function parseStringGrantListFromJson(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function parseStoredPermissions(raw: string | null | undefined): Permission[] {
  if (!raw) return [];
  try {
    return parsePermissions(JSON.parse(raw), false);
  } catch {
    return [];
  }
}

function isAdminAccount(user: { role: string; accessRole: CanonicalAccessRole | null }): boolean {
  return user.accessRole === "admin" || (!user.accessRole && user.role === "admin");
}

export class UsersService {
  constructor(private readonly repository: UsersRepository = usersRepository) {}

  private async validateCanonicalInput(body: Record<string, unknown>): Promise<CanonicalInput> {
    if (!isAccessRole(body.accessRole)) {
      throw new UserRequestError(400, "Access Role must be Agent, Manager, or Admin");
    }
    const accessRole = body.accessRole;
    const teamGrants = parseStringGrantList(body.teamGrants, VALID_TEAMS, "team grant");
    const tabGrants = parseStringGrantList(body.tabGrants, CANONICAL_DASHBOARD_TABS, "tab grant");
    const permissions = accessRole === "admin"
      ? [...ALL_PERMISSIONS]
      : parsePermissions(body.permissions, true);

    if (accessRole === "agent") {
      const teamAgentId = Number(body.teamAgentId);
      if (!Number.isInteger(teamAgentId) || teamAgentId <= 0) {
        throw new UserRequestError(400, "Canonical Agent is required");
      }
      if (body.primaryTeam != null && body.primaryTeam !== "") {
        throw new UserRequestError(400, "Agent accounts cannot have a primary team");
      }
      const agent = await this.repository.loadCanonicalAgent(teamAgentId);
      if (!agent?.active || !agent.nameNormalized || !isTeam(agent.team)) {
        throw new UserRequestError(400, "Select an active canonical Agent Roster identity");
      }
      return {
        accessRole,
        teamAgentId,
        primaryTeam: null,
        teamGrants,
        tabGrants,
        permissions,
        compatibilityRole: "view",
        rosterEmailNormalized: agent.emailNormalized,
      };
    }

    if (accessRole === "manager") {
      if (!isPrimaryTeam(body.primaryTeam)) throw new UserRequestError(400, "Primary Team is required");
      if (body.teamAgentId != null && body.teamAgentId !== "") {
        throw new UserRequestError(400, "Manager accounts cannot link to a roster Agent");
      }
      return {
        accessRole,
        teamAgentId: null,
        primaryTeam: body.primaryTeam,
        teamGrants,
        tabGrants,
        permissions,
        compatibilityRole: "view",
        rosterEmailNormalized: null,
      };
    }

    if ((body.teamAgentId != null && body.teamAgentId !== "") || (body.primaryTeam != null && body.primaryTeam !== "")) {
      throw new UserRequestError(400, "Admin accounts cannot have an Agent or Primary Team link");
    }
    if (teamGrants.length || tabGrants.length) {
      throw new UserRequestError(400, "Admin accounts do not use team or tab grants");
    }
    return {
      accessRole,
      teamAgentId: null,
      primaryTeam: null,
      teamGrants: [],
      tabGrants: [],
      permissions,
      compatibilityRole: "admin",
      rosterEmailNormalized: null,
    };
  }

  private async ensurePortalEmailDoesNotClaimAnotherRosterIdentity(
    emailNormalized: string | null,
    targetTeamAgentId: number | null,
  ): Promise<void> {
    if (!emailNormalized) return;
    const rosterIdentity = await this.repository.findRosterIdentityByEmail(emailNormalized);
    if (rosterIdentity && rosterIdentity.id !== targetTeamAgentId) {
      throw new UserRequestError(409, "Email belongs to another Agent Roster identity");
    }
  }

  private async ensureAnotherActiveAdmin(userId: number): Promise<void> {
    const users = await this.repository.listAdminCandidates();
    if (!users.some((candidate) => candidate.id !== userId && candidate.active && isAdminAccount(candidate))) {
      throw new UserRequestError(400, "Cannot remove the last active administrator");
    }
  }

  async listUsers() {
    const { users, teamGrants, tabGrants } = await this.repository.listUsersData();
    const teamsByUser = new Map<number, TeamSlug[]>();
    const tabsByUser = new Map<number, CanonicalDashboardTab[]>();
    for (const grant of teamGrants) {
      teamsByUser.set(grant.portalUserId, [...(teamsByUser.get(grant.portalUserId) ?? []), grant.team]);
    }
    for (const grant of tabGrants) {
      tabsByUser.set(grant.portalUserId, [...(tabsByUser.get(grant.portalUserId) ?? []), grant.tab]);
    }

    return users.map(({
      passwordHash: _passwordHash,
      emailNormalized: _emailNormalized,
      canonicalAgentEmail,
      ...user
    }) => ({
      ...user,
      loginEmail: user.email ?? canonicalAgentEmail ?? null,
      permissions: isAdminAccount(user) ? [...ALL_PERMISSIONS] : parseStoredPermissions(user.permissions),
      allowedTabs: parseStringGrantListFromJson(user.allowedTabs),
      allowedAgents: parseStringGrantListFromJson(user.allowedAgents),
      allowedSubTabs: parseStringGrantListFromJson(user.allowedSubTabs),
      teamGrants: teamsByUser.get(user.id) ?? [],
      tabGrants: tabsByUser.get(user.id) ?? [],
      canonicalAgent: user.canonicalAgentId ? {
        id: user.canonicalAgentId,
        name: user.canonicalAgentName,
        team: user.canonicalAgentTeam,
        active: user.canonicalAgentActive,
      } : null,
    }));
  }

  async createUser(rawBody: unknown) {
    const body = requestBody(rawBody);
    const username = normalizeUsername(body.username);
    const passwordError = validateNewPassword(body.password);
    if (passwordError) throw new UserRequestError(400, passwordError);
    const access = await this.validateCanonicalInput(body);
    const emailIdentity = portalUserEmailIdentity(body.email, { required: !access.rosterEmailNormalized });
    await this.ensurePortalEmailDoesNotClaimAnotherRosterIdentity(
      emailIdentity.emailNormalized,
      access.teamAgentId,
    );
    const passwordHash = await bcrypt.hash(body.password as string, 10);
    const userId = await this.repository.createUser({
      username,
      ...emailIdentity,
      passwordHash,
      passwordPolicyVersion: CURRENT_PASSWORD_POLICY_VERSION,
      passwordChangedAt: new Date(),
      role: access.compatibilityRole,
      permissions: JSON.stringify(access.permissions),
      teamAccess: null,
      allowedTabs: null,
      allowedAgents: null,
      allowedSubTabs: null,
      lockToToday: false,
      samiaCurse: false,
      hideBackendStats: false,
      accessRole: access.accessRole,
      teamAgentId: access.teamAgentId,
      primaryTeam: access.primaryTeam,
    }, access);
    return (await this.listUsers()).find((user) => user.id === userId);
  }

  async updateUser(input: { actorId: number | undefined; id: unknown; body: unknown }) {
    const id = parseId(input.id);
    const body = requestBody(input.body);
    const existing = await this.repository.findUser(id);
    if (!existing) throw new UserRequestError(404, "User not found");

    const requestedActive = body.active;
    if (requestedActive !== undefined && typeof requestedActive !== "boolean") {
      throw new UserRequestError(400, "Active must be a boolean");
    }
    const canonicalChange = Object.prototype.hasOwnProperty.call(body, "accessRole");
    if (canonicalChange && body.accessRole == null) {
      throw new UserRequestError(400, "Canonical accounts cannot be reverted to legacy mode");
    }
    const access = canonicalChange ? await this.validateCanonicalInput(body) : null;
    const targetAdmin = access
      ? access.accessRole === "admin"
      : !existing.accessRole && typeof body.role === "string"
        ? body.role === "admin"
        : isAdminAccount(existing);
    if (input.actorId === id && (requestedActive === false || !targetAdmin)) {
      throw new UserRequestError(400, "Cannot deactivate or demote your own account");
    }
    if (existing.active && isAdminAccount(existing) && (requestedActive === false || !targetAdmin)) {
      await this.ensureAnotherActiveAdmin(id);
    }

    const updates: PortalUserUpdates = {};
    if (Object.prototype.hasOwnProperty.call(body, "username")) updates.username = normalizeUsername(body.username);
    const emailWasChanged = Object.prototype.hasOwnProperty.call(body, "email");
    if (emailWasChanged) Object.assign(updates, portalUserEmailIdentity(body.email));
    const targetTeamAgentId = access ? access.teamAgentId : existing.teamAgentId;
    const rosterEmailNormalized = access
      ? access.rosterEmailNormalized
      : targetTeamAgentId
        ? await this.repository.loadRosterEmailNormalized(targetTeamAgentId)
        : null;
    const effectiveEmailNormalized = (emailWasChanged ? updates.emailNormalized : existing.emailNormalized)
      ?? rosterEmailNormalized;
    const targetActive = typeof requestedActive === "boolean" ? requestedActive : existing.active;
    if (targetActive && !effectiveEmailNormalized) {
      throw new UserRequestError(400, "Active users require an email address for login");
    }
    if (emailWasChanged) {
      await this.ensurePortalEmailDoesNotClaimAnotherRosterIdentity(
        updates.emailNormalized ?? null,
        targetTeamAgentId,
      );
    }
    const passwordWasChanged = typeof body.password === "string" && body.password.length > 0;
    if (passwordWasChanged) {
      const passwordError = validateNewPassword(body.password);
      if (passwordError) throw new UserRequestError(400, passwordError);
      updates.passwordHash = await bcrypt.hash(body.password as string, 10);
      updates.passwordPolicyVersion = CURRENT_PASSWORD_POLICY_VERSION;
      updates.passwordChangedAt = new Date();
    } else if (body.password !== undefined && typeof body.password !== "string") {
      throw new UserRequestError(400, "Password must be a string");
    }
    if (typeof requestedActive === "boolean") updates.active = requestedActive;

    if (access) {
      Object.assign(updates, {
        accessRole: access.accessRole,
        teamAgentId: access.teamAgentId,
        primaryTeam: access.primaryTeam,
        role: access.compatibilityRole,
        permissions: JSON.stringify(access.permissions),
        teamAccess: null,
        allowedTabs: null,
        allowedAgents: null,
        allowedSubTabs: null,
        lockToToday: false,
        hideBackendStats: false,
      });
    } else if (!existing.accessRole) {
      if (typeof body.role === "string" && ["admin", "edit", "view"].includes(body.role)) {
        updates.role = body.role as "admin" | "edit" | "view";
      }
      if (body.permissions !== undefined) {
        updates.permissions = JSON.stringify(parsePermissions(body.permissions, targetAdmin));
      }
      if (Object.prototype.hasOwnProperty.call(body, "teamAccess")) {
        const value = body.teamAccess;
        if (value !== null && value !== "" && !(typeof value === "string" && ["retention", "nsf", "cs"].includes(value))) {
          throw new UserRequestError(400, "Invalid legacy team access");
        }
        updates.teamAccess = value || null;
      }
      for (const [field, column] of [
        ["allowedTabs", "allowedTabs"],
        ["allowedAgents", "allowedAgents"],
        ["allowedSubTabs", "allowedSubTabs"],
      ] as const) {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
          const value = body[field];
          if (value != null && !Array.isArray(value)) {
            throw new UserRequestError(400, `${field} must be an array`);
          }
          updates[column] = value && (value as unknown[]).length ? JSON.stringify(value) : null;
        }
      }
      if (typeof body.lockToToday === "boolean") updates.lockToToday = body.lockToToday;
      if (typeof body.hideBackendStats === "boolean") updates.hideBackendStats = body.hideBackendStats;
    } else {
      const forbidden = ["role", "permissions", "teamAccess", "allowedTabs", "allowedAgents", "allowedSubTabs", "lockToToday"]
        .some((field) => Object.prototype.hasOwnProperty.call(body, field));
      if (forbidden) {
        throw new UserRequestError(400, "Canonical access changes require a complete Access Role payload");
      }
    }
    if (typeof body.samiaCurse === "boolean") updates.samiaCurse = body.samiaCurse;
    if (!Object.keys(updates).length && !access) throw new UserRequestError(400, "Nothing to update");

    const persistenceClassChanged = targetAdmin !== isAdminAccount(existing);
    await this.repository.updateUser({
      id,
      updates,
      grants: access as PortalUserGrantUpdate | null,
      revokeSessions: passwordWasChanged
        || requestedActive === false
        || emailWasChanged
        || persistenceClassChanged,
    });
    return (await this.listUsers()).find((user) => user.id === id);
  }

  async deleteUser(input: { actorId: number | undefined; id: unknown }): Promise<{ ok: true }> {
    const id = parseId(input.id);
    if (input.actorId === id) throw new UserRequestError(400, "Cannot delete your own account");
    const existing = await this.repository.findUser(id);
    if (!existing) throw new UserRequestError(404, "User not found");
    if (existing.active && isAdminAccount(existing)) await this.ensureAnotherActiveAdmin(id);
    await this.repository.deleteUser(id);
    return { ok: true };
  }
}

export const usersService = new UsersService();
