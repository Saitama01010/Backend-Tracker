import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { portalUsersTable, ALL_PERMISSIONS } from "@workspace/db/schema";
import type { Permission } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

function parsePermissions(raw: string | null | undefined, role: string): Permission[] {
  if (role === "admin") return [...ALL_PERMISSIONS];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as Permission[] : [];
  } catch { return []; }
}

const SELECTABLE = {
  id: portalUsersTable.id,
  username: portalUsersTable.username,
  role: portalUsersTable.role,
  permissions: portalUsersTable.permissions,
  teamAccess: portalUsersTable.teamAccess,
  allowedTabs: portalUsersTable.allowedTabs,
  allowedAgents: portalUsersTable.allowedAgents,
  allowedSubTabs: portalUsersTable.allowedSubTabs,
  lockToToday: portalUsersTable.lockToToday,
  samiaCurse: portalUsersTable.samiaCurse,
  hideBackendStats: portalUsersTable.hideBackendStats,
  active: portalUsersTable.active,
  createdAt: portalUsersTable.createdAt,
};

function parseJsonArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed as string[] : null;
  } catch { return null; }
}

router.get("/users", requireAuth, requireRole("admin"), async (_req, res) => {
  const users = await db.select(SELECTABLE).from(portalUsersTable).orderBy(portalUsersTable.createdAt);
  res.json(users.map((u) => ({ ...u, permissions: parsePermissions(u.permissions, u.role), allowedTabs: parseJsonArray(u.allowedTabs), allowedAgents: parseJsonArray(u.allowedAgents), allowedSubTabs: parseJsonArray(u.allowedSubTabs) })));
});

const VALID_SUB_TABS = ["call", "files", "day"] as const;
function serializeSubTabs(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const filtered = v.filter((x): x is string => typeof x === "string" && (VALID_SUB_TABS as readonly string[]).includes(x));
  return filtered.length > 0 ? JSON.stringify(filtered) : null;
}

const VALID_TEAM_ACCESS = ["retention", "nsf", "cs"] as const;
type ValidTeamAccess = typeof VALID_TEAM_ACCESS[number];
function parseTeamAccess(v: unknown): ValidTeamAccess | null {
  return typeof v === "string" && VALID_TEAM_ACCESS.includes(v as ValidTeamAccess) ? (v as ValidTeamAccess) : null;
}

function serializeJsonArray(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return JSON.stringify(v);
}

router.post("/users", requireAuth, requireRole("admin"), async (req, res) => {
  const { username, password, role, permissions, teamAccess, allowedTabs, allowedAgents, allowedSubTabs, lockToToday, samiaCurse, hideBackendStats } = req.body ?? {};
  if (!username || !password || !["admin", "edit", "view"].includes(role)) {
    res.status(400).json({ error: "username, password and role required" });
    return;
  }
  const perms: Permission[] = role === "admin" ? [...ALL_PERMISSIONS] : (Array.isArray(permissions) ? permissions : []);
  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(portalUsersTable)
    .values({
      username: username.trim().toLowerCase(),
      passwordHash,
      role,
      permissions: JSON.stringify(perms),
      teamAccess: parseTeamAccess(teamAccess),
      allowedTabs: serializeJsonArray(allowedTabs),
      allowedAgents: serializeJsonArray(allowedAgents),
      allowedSubTabs: serializeSubTabs(allowedSubTabs),
      lockToToday: !!lockToToday,
      samiaCurse: !!samiaCurse,
      hideBackendStats: !!hideBackendStats,
    })
    .returning(SELECTABLE);
  res.json({ ...user, permissions: parsePermissions(user.permissions, user.role), allowedTabs: parseJsonArray(user.allowedTabs), allowedAgents: parseJsonArray(user.allowedAgents), allowedSubTabs: parseJsonArray(user.allowedSubTabs) });
});

router.patch("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const { username, password, role, active, permissions, teamAccess, allowedTabs, allowedAgents, allowedSubTabs, lockToToday, samiaCurse, hideBackendStats } = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (username) updates["username"] = username.trim().toLowerCase();
  if (password) updates["passwordHash"] = await bcrypt.hash(password, 10);
  if (role && ["admin", "edit", "view"].includes(role)) updates["role"] = role;
  if (typeof active === "boolean") updates["active"] = active;
  if (Array.isArray(permissions)) updates["permissions"] = JSON.stringify(permissions);
  if ("teamAccess" in (req.body ?? {})) updates["teamAccess"] = parseTeamAccess(teamAccess);
  if ("allowedTabs" in (req.body ?? {})) updates["allowedTabs"] = serializeJsonArray(allowedTabs);
  if ("allowedAgents" in (req.body ?? {})) updates["allowedAgents"] = serializeJsonArray(allowedAgents);
  if ("allowedSubTabs" in (req.body ?? {})) updates["allowedSubTabs"] = serializeSubTabs(allowedSubTabs);
  if ("lockToToday" in (req.body ?? {})) updates["lockToToday"] = !!lockToToday;
  if ("samiaCurse" in (req.body ?? {})) updates["samiaCurse"] = !!samiaCurse;
  if ("hideBackendStats" in (req.body ?? {})) updates["hideBackendStats"] = !!hideBackendStats;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [user] = await db
    .update(portalUsersTable)
    .set(updates)
    .where(eq(portalUsersTable.id, id))
    .returning(SELECTABLE);
  res.json({ ...user, permissions: parsePermissions(user.permissions, user.role), allowedTabs: parseJsonArray(user.allowedTabs), allowedAgents: parseJsonArray(user.allowedAgents), allowedSubTabs: parseJsonArray(user.allowedSubTabs) });
});

router.delete("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (req.user?.userId === id) { res.status(400).json({ error: "Cannot delete your own account" }); return; }
  await db.delete(portalUsersTable).where(eq(portalUsersTable.id, id));
  res.json({ ok: true });
});

export default router;
