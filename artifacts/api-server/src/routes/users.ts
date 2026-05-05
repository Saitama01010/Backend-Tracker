import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { portalUsersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/users", requireAuth, requireRole("admin"), async (_req, res) => {
  const users = await db
    .select({ id: portalUsersTable.id, username: portalUsersTable.username, role: portalUsersTable.role, active: portalUsersTable.active, createdAt: portalUsersTable.createdAt })
    .from(portalUsersTable)
    .orderBy(portalUsersTable.createdAt);
  res.json(users);
});

router.post("/users", requireAuth, requireRole("admin"), async (req, res) => {
  const { username, password, role } = req.body ?? {};
  if (!username || !password || !["admin", "edit", "view"].includes(role)) {
    res.status(400).json({ error: "username, password and role required" });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(portalUsersTable)
    .values({ username: username.trim().toLowerCase(), passwordHash, role })
    .returning({ id: portalUsersTable.id, username: portalUsersTable.username, role: portalUsersTable.role, active: portalUsersTable.active });
  res.json(user);
});

router.patch("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const { username, password, role, active } = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (username) updates["username"] = username.trim().toLowerCase();
  if (password) updates["passwordHash"] = await bcrypt.hash(password, 10);
  if (role && ["admin", "edit", "view"].includes(role)) updates["role"] = role;
  if (typeof active === "boolean") updates["active"] = active;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [user] = await db
    .update(portalUsersTable)
    .set(updates)
    .where(eq(portalUsersTable.id, id))
    .returning({ id: portalUsersTable.id, username: portalUsersTable.username, role: portalUsersTable.role, active: portalUsersTable.active });
  res.json(user);
});

export default router;
