import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { portalUsersTable, ALL_PERMISSIONS } from "@workspace/db/schema";
import type { Permission } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { signToken, requireAuth } from "../middleware/auth.js";

const router = Router();

const isProduction = () => process.env["NODE_ENV"] === "production" || process.env["VERCEL"] === "1";

function dashboardPassword(): string {
  const value = process.env["DASHBOARD_PASSWORD"];
  if (value) return value;
  if (isProduction()) {
    throw new Error("DASHBOARD_PASSWORD is required in production.");
  }
  return "tracker2026";
}

let adminPasswordSynced = false;

async function seedAdminUser() {
  const defaultPass = dashboardPassword();
  const hash = await bcrypt.hash(defaultPass, 10);
  const [user] = await db
    .insert(portalUsersTable)
    .values({
      username: "admin",
      passwordHash: hash,
      role: "admin",
      permissions: JSON.stringify([...ALL_PERMISSIONS]),
      active: true,
    })
    .onConflictDoNothing()
    .returning();
  return user;
}

async function syncAdminPasswordFromEnv<T extends { id: number; username: string; passwordHash: string }>(user: T): Promise<T> {
  if (adminPasswordSynced || user.username !== "admin" || !process.env["DASHBOARD_PASSWORD"]) {
    return user;
  }

  const hash = await bcrypt.hash(dashboardPassword(), 10);
  await db
    .update(portalUsersTable)
    .set({ passwordHash: hash })
    .where(eq(portalUsersTable.id, user.id));
  adminPasswordSynced = true;
  return { ...user, passwordHash: hash };
}

function parsePermissions(raw: string | null | undefined, role: string): Permission[] {
  if (role === "admin") return [...ALL_PERMISSIONS];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as Permission[] : [];
  } catch { return []; }
}

function parseJsonArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed as string[] : null;
  } catch { return null; }
}

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password required" });
    return;
  }
  const normalizedUsername = username.trim().toLowerCase();
  let [user] = await db
    .select()
    .from(portalUsersTable)
    .where(eq(portalUsersTable.username, normalizedUsername))
    .limit(1);

  if (!user && normalizedUsername === "admin") {
    user = await seedAdminUser();
  }

  if (user && normalizedUsername === "admin") {
    user = await syncAdminPasswordFromEnv(user);
  }

  if (!user || !user.active) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const permissions = parsePermissions(user.permissions, user.role);
  const teamAccess = (user.teamAccess ?? null) as "retention" | "nsf" | "cs" | null;
  const allowedTabs = parseJsonArray(user.allowedTabs);
  const allowedAgents = parseJsonArray(user.allowedAgents);
  const allowedSubTabs = parseJsonArray(user.allowedSubTabs);
  const lockToToday = !!user.lockToToday;
  const hideBackendStats = !!user.hideBackendStats;
  const token = signToken({ userId: user.id, username: user.username, role: user.role as "admin" | "edit" | "view", permissions, teamAccess, allowedTabs, allowedAgents, allowedSubTabs, lockToToday, hideBackendStats });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, permissions, teamAccess, allowedTabs, allowedAgents, allowedSubTabs, lockToToday, hideBackendStats } });
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, req.user!.userId))
    .limit(1);
  if (!user || !user.active) {
    res.status(401).json({ error: "User not found or inactive" });
    return;
  }
  const permissions = parsePermissions(user.permissions, user.role);
  const teamAccess = (user.teamAccess ?? null) as "retention" | "nsf" | "cs" | null;
  const allowedTabs = parseJsonArray(user.allowedTabs);
  const allowedAgents = parseJsonArray(user.allowedAgents);
  const allowedSubTabs = parseJsonArray(user.allowedSubTabs);
  const lockToToday = !!user.lockToToday;
  const hideBackendStats = !!user.hideBackendStats;
  const token = signToken({ userId: user.id, username: user.username, role: user.role as "admin" | "edit" | "view", permissions, teamAccess, allowedTabs, allowedAgents, allowedSubTabs, lockToToday, hideBackendStats });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, permissions, teamAccess, allowedTabs, allowedAgents, allowedSubTabs, lockToToday, hideBackendStats } });
});

export default router;
