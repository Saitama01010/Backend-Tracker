import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { ALL_PERMISSIONS, portalUsersTable } from "@workspace/db/schema";
import type { Permission, TeamAccess } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export interface AuthPayload {
  userId: number;
  username: string;
  role: "admin" | "edit" | "view";
  permissions: Permission[];
  teamAccess?: TeamAccess | null;
  allowedTabs?: string[] | null;
  allowedAgents?: string[] | null;
  allowedSubTabs?: string[] | null;
  lockToToday?: boolean;
  samiaCurse?: boolean;
  hideBackendStats?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

const isProduction = () => process.env["NODE_ENV"] === "production" || process.env["VERCEL"] === "1";

const secret = () => {
  const value = process.env["SESSION_SECRET"];
  if (value) return value;
  if (isProduction()) {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return "dev-secret-change-me";
};

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, secret(), { expiresIn: "30d" });
}

function parsePermissions(raw: string | null | undefined, role: string): Permission[] {
  if (role === "admin") return [...ALL_PERMISSIONS];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is Permission => (ALL_PERMISSIONS as readonly string[]).includes(p))
      : [];
  } catch {
    return [];
  }
}

function parseJsonArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0
      ? parsed.filter((item): item is string => typeof item === "string")
      : null;
  } catch {
    return null;
  }
}

function parseTeamAccess(raw: string | null | undefined): TeamAccess | null {
  return raw === "retention" || raw === "nsf" || raw === "cs" ? raw : null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers["authorization"];
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const payload = jwt.verify(token, secret()) as AuthPayload;
    const [user] = await db
      .select()
      .from(portalUsersTable)
      .where(eq(portalUsersTable.id, payload.userId))
      .limit(1);

    if (!user || !user.active) {
      res.status(401).json({ error: "User not found or inactive" });
      return;
    }

    req.user = {
      userId: user.id,
      username: user.username,
      role: user.role,
      permissions: parsePermissions(user.permissions, user.role),
      teamAccess: parseTeamAccess(user.teamAccess),
      allowedTabs: parseJsonArray(user.allowedTabs),
      allowedAgents: parseJsonArray(user.allowedAgents),
      allowedSubTabs: parseJsonArray(user.allowedSubTabs),
      lockToToday: !!user.lockToToday,
      samiaCurse: !!user.samiaCurse,
      hideBackendStats: !!user.hideBackendStats,
    };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: Array<"admin" | "edit" | "view">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.permissions.includes(permission)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
