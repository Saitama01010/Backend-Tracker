import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { portalUsersTable, ALL_PERMISSIONS } from "@workspace/db/schema";
import type { Permission } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

function parsePermissions(raw: string, role: string): Permission[] {
  if (role === "admin") return [...ALL_PERMISSIONS];
  try { return JSON.parse(raw) as Permission[]; } catch { return []; }
}

const SELECTABLE = {
  id: portalUsersTable.id,
  username: portalUsersTable.username,
  role: portalUsersTable.role,
  permissions: portalUsersTable.permissions,
  active: portalUsersTable.active,
  createdAt: portalUsersTable.createdAt,
};

router.get("/users", requireAuth, requireRole("admin"), async (_req, res) => {
  const users = await db.select(SELECTABLE).from(portalUsersTable).orderBy(portalUsersTable.createdAt);
  res.json(users.map((u) => ({ ...u, permissions: parsePermissions(u.permissions, u.role) })));
});

router.post("/users", requireAuth, requireRole("admin"), async (req, res) => {
  const { username, password, role, permissions } = req.body ?? {};
  if (!username || !password || !["admin", "edit", "view"].includes(role)) {
    res.status(400).json({ error: "username, password and role required" });
    return;
  }
  const perms: Permission[] = role === "admin" ? [...ALL_PERMISSIONS] : (Array.isArray(permissions) ? permissions : []);
  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(portalUsersTable)
    .values({ username: username.trim().toLowerCase(), passwordHash, role, permissions: JSON.stringify(perms) })
    .returning(SELECTABLE);
  res.json({ ...user, permissions: parsePermissions(user.permissions, user.role) });
});

router.patch("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const { username, password, role, active, permissions } = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (username) updates["username"] = username.trim().toLowerCase();
  if (password) updates["passwordHash"] = await bcrypt.hash(password, 10);
  if (role && ["admin", "edit", "view"].includes(role)) updates["role"] = role;
  if (typeof active === "boolean") updates["active"] = active;
  if (Array.isArray(permissions)) updates["permissions"] = JSON.stringify(permissions);
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [user] = await db
    .update(portalUsersTable)
    .set(updates)
    .where(eq(portalUsersTable.id, id))
    .returning(SELECTABLE);
  res.json({ ...user, permissions: parsePermissions(user.permissions, user.role) });
});

export default router;
