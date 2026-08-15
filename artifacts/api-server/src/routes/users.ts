import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { isValidAgentEmail, normalizeAgentEmail } from "@workspace/api-zod/agent-identity";
import { db } from "@workspace/db";
import {
  ALL_PERMISSIONS,
  CANONICAL_ACCESS_ROLES,
  CANONICAL_DASHBOARD_TABS,
  portalUsersTable,
  portalUserTabGrantsTable,
  portalUserTeamGrantsTable,
  teamAgentsTable,
  VALID_TEAMS,
} from "@workspace/db/schema";
import type {
  CanonicalAccessRole,
  CanonicalDashboardTab,
  Permission,
  TeamSlug,
} from "@workspace/db/schema";
import { asc, eq, getTableColumns } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { CURRENT_PASSWORD_POLICY_VERSION, validateNewPassword } from "../lib/passwordPolicy.js";
import { revokeUserSessions } from "../lib/sessionStore.js";

const router = Router();

class UserRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new UserRequestError(400, "Username is required");
  }
  return value.trim().toLowerCase();
}

function portalUserEmailIdentity(value: unknown): { email: string | null; emailNormalized: string | null } {
  if (value == null || (typeof value === "string" && !value.trim())) {
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

type CanonicalInput = {
  accessRole: CanonicalAccessRole;
  teamAgentId: number | null;
  primaryTeam: TeamSlug | null;
  teamGrants: TeamSlug[];
  tabGrants: CanonicalDashboardTab[];
  permissions: Permission[];
  compatibilityRole: "admin" | "view";
};

async function validateCanonicalInput(body: Record<string, unknown>): Promise<CanonicalInput> {
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
    const [agent] = await db.select({
      id: teamAgentsTable.id,
      nameNormalized: teamAgentsTable.nameNormalized,
      team: teamAgentsTable.team,
      active: teamAgentsTable.active,
    }).from(teamAgentsTable).where(eq(teamAgentsTable.id, teamAgentId)).limit(1);
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
    };
  }

  if (accessRole === "manager") {
    if (!isTeam(body.primaryTeam)) throw new UserRequestError(400, "Primary Team is required");
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
  };
}

async function replaceGrants(
  executor: Pick<typeof db, "delete" | "insert">,
  userId: number,
  access: CanonicalInput,
): Promise<void> {
  await executor.delete(portalUserTeamGrantsTable)
    .where(eq(portalUserTeamGrantsTable.portalUserId, userId));
  await executor.delete(portalUserTabGrantsTable)
    .where(eq(portalUserTabGrantsTable.portalUserId, userId));
  if (access.teamGrants.length) {
    await executor.insert(portalUserTeamGrantsTable).values(
      access.teamGrants.map((team) => ({ portalUserId: userId, team })),
    );
  }
  if (access.tabGrants.length) {
    await executor.insert(portalUserTabGrantsTable).values(
      access.tabGrants.map((tab) => ({ portalUserId: userId, tab })),
    );
  }
}

async function listPortalUsers() {
  const [users, teamGrants, tabGrants] = await Promise.all([
    db.select({
      ...getTableColumns(portalUsersTable),
      canonicalAgentId: teamAgentsTable.id,
      canonicalAgentName: teamAgentsTable.name,
      canonicalAgentTeam: teamAgentsTable.team,
      canonicalAgentActive: teamAgentsTable.active,
    })
      .from(portalUsersTable)
      .leftJoin(teamAgentsTable, eq(portalUsersTable.teamAgentId, teamAgentsTable.id))
      .orderBy(asc(portalUsersTable.createdAt)),
    db.select().from(portalUserTeamGrantsTable),
    db.select().from(portalUserTabGrantsTable),
  ]);
  const teamsByUser = new Map<number, TeamSlug[]>();
  const tabsByUser = new Map<number, CanonicalDashboardTab[]>();
  for (const grant of teamGrants) teamsByUser.set(grant.portalUserId, [...(teamsByUser.get(grant.portalUserId) ?? []), grant.team]);
  for (const grant of tabGrants) tabsByUser.set(grant.portalUserId, [...(tabsByUser.get(grant.portalUserId) ?? []), grant.tab]);

  return users.map(({ passwordHash: _passwordHash, emailNormalized: _emailNormalized, ...user }) => ({
    ...user,
    permissions: user.accessRole === "admin" || (!user.accessRole && user.role === "admin")
      ? [...ALL_PERMISSIONS]
      : parseStoredPermissions(user.permissions),
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

async function ensureAnotherActiveAdmin(userId: number): Promise<void> {
  const users = await db.select({
    id: portalUsersTable.id,
    role: portalUsersTable.role,
    accessRole: portalUsersTable.accessRole,
    active: portalUsersTable.active,
  }).from(portalUsersTable);
  if (!users.some((candidate) => candidate.id !== userId && candidate.active && isAdminAccount(candidate))) {
    throw new UserRequestError(400, "Cannot remove the last active administrator");
  }
}

function postgresCode(error: unknown): string | null {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate && typeof candidate === "object"; depth += 1) {
    const record = candidate as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    candidate = record.cause;
  }
  return null;
}

function postgresConstraint(error: unknown): string | null {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate && typeof candidate === "object"; depth += 1) {
    const record = candidate as { constraint?: unknown; cause?: unknown };
    if (typeof record.constraint === "string") return record.constraint;
    candidate = record.cause;
  }
  return null;
}

function sendUserError(req: Request, res: Response, error: unknown): void {
  if (error instanceof UserRequestError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (postgresCode(error) === "23505") {
    if (postgresConstraint(error) === "portal_users_email_normalized_uidx") {
      res.status(409).json({ error: "Email is already assigned to another user" });
      return;
    }
    res.status(409).json({ error: "Username or canonical Agent is already assigned" });
    return;
  }
  req.log.error(error, "portal user management failed");
  res.status(500).json({ error: "Failed to save portal user" });
}

router.get("/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    res.json(await listPortalUsers());
  } catch (error) {
    sendUserError(req, res, error);
  }
});

router.post("/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const username = normalizeUsername(body.username);
    const emailIdentity = portalUserEmailIdentity(body.email);
    const passwordError = validateNewPassword(body.password);
    if (passwordError) throw new UserRequestError(400, passwordError);
    const access = await validateCanonicalInput(body);
    const passwordHash = await bcrypt.hash(body.password as string, 10);

    const userId = await db.transaction(async (tx) => {
      const [user] = await tx.insert(portalUsersTable).values({
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
      }).returning({ id: portalUsersTable.id });
      await replaceGrants(tx, user!.id, access);
      return user!.id;
    });
    const created = (await listPortalUsers()).find((user) => user.id === userId);
    res.status(201).json(created);
  } catch (error) {
    sendUserError(req, res, error);
  }
});

router.patch("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new UserRequestError(400, "Invalid id");
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const [existing] = await db.select().from(portalUsersTable).where(eq(portalUsersTable.id, id)).limit(1);
    if (!existing) throw new UserRequestError(404, "User not found");

    const requestedActive = body.active;
    if (requestedActive !== undefined && typeof requestedActive !== "boolean") {
      throw new UserRequestError(400, "Active must be a boolean");
    }
    const canonicalChange = Object.prototype.hasOwnProperty.call(body, "accessRole");
    if (canonicalChange && body.accessRole == null) {
      throw new UserRequestError(400, "Canonical accounts cannot be reverted to legacy mode");
    }
    const access = canonicalChange ? await validateCanonicalInput(body) : null;
    const targetAdmin = access
      ? access.accessRole === "admin"
      : !existing.accessRole && typeof body.role === "string"
        ? body.role === "admin"
        : isAdminAccount(existing);
    if (req.user?.userId === id && (requestedActive === false || !targetAdmin)) {
      throw new UserRequestError(400, "Cannot deactivate or demote your own account");
    }
    if (existing.active && isAdminAccount(existing) && (requestedActive === false || !targetAdmin)) {
      await ensureAnotherActiveAdmin(id);
    }

    const updates: Partial<typeof portalUsersTable.$inferInsert> = {};
    if (Object.prototype.hasOwnProperty.call(body, "username")) updates.username = normalizeUsername(body.username);
    if (Object.prototype.hasOwnProperty.call(body, "email")) Object.assign(updates, portalUserEmailIdentity(body.email));
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
      if (typeof body.role === "string" && ["admin", "edit", "view"].includes(body.role)) updates.role = body.role as "admin" | "edit" | "view";
      if (body.permissions !== undefined) updates.permissions = JSON.stringify(parsePermissions(body.permissions, targetAdmin));
      if (Object.prototype.hasOwnProperty.call(body, "teamAccess")) {
        const value = body.teamAccess;
        if (value !== null && value !== "" && !(typeof value === "string" && ["retention", "nsf", "cs"].includes(value))) {
          throw new UserRequestError(400, "Invalid legacy team access");
        }
        updates.teamAccess = value || null;
      }
      for (const [input, column] of [["allowedTabs", "allowedTabs"], ["allowedAgents", "allowedAgents"], ["allowedSubTabs", "allowedSubTabs"]] as const) {
        if (Object.prototype.hasOwnProperty.call(body, input)) {
          const value = body[input];
          if (value != null && !Array.isArray(value)) throw new UserRequestError(400, `${input} must be an array`);
          updates[column] = value && (value as unknown[]).length ? JSON.stringify(value) : null;
        }
      }
      if (typeof body.lockToToday === "boolean") updates.lockToToday = body.lockToToday;
      if (typeof body.hideBackendStats === "boolean") updates.hideBackendStats = body.hideBackendStats;
    } else {
      const forbidden = ["role", "permissions", "teamAccess", "allowedTabs", "allowedAgents", "allowedSubTabs", "lockToToday"]
        .some((field) => Object.prototype.hasOwnProperty.call(body, field));
      if (forbidden) throw new UserRequestError(400, "Canonical access changes require a complete Access Role payload");
    }
    if (typeof body.samiaCurse === "boolean") updates.samiaCurse = body.samiaCurse;
    if (!Object.keys(updates).length && !access) throw new UserRequestError(400, "Nothing to update");

    await db.transaction(async (tx) => {
      if (Object.keys(updates).length) {
        await tx.update(portalUsersTable).set(updates).where(eq(portalUsersTable.id, id));
      }
      if (access) await replaceGrants(tx, id, access);
      if (passwordWasChanged || requestedActive === false) {
        await revokeUserSessions(id, tx);
      }
    });
    const updated = (await listPortalUsers()).find((user) => user.id === id);
    res.json(updated);
  } catch (error) {
    sendUserError(req, res, error);
  }
});

router.delete("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new UserRequestError(400, "Invalid id");
    if (req.user?.userId === id) throw new UserRequestError(400, "Cannot delete your own account");
    const [existing] = await db.select().from(portalUsersTable).where(eq(portalUsersTable.id, id)).limit(1);
    if (!existing) throw new UserRequestError(404, "User not found");
    if (existing.active && isAdminAccount(existing)) await ensureAnotherActiveAdmin(id);
    await db.delete(portalUsersTable).where(eq(portalUsersTable.id, id));
    res.json({ ok: true });
  } catch (error) {
    sendUserError(req, res, error);
  }
});

export default router;
