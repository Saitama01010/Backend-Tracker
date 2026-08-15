import type { Request, Response, NextFunction } from "express";
import { performance } from "node:perf_hooks";
import type { Permission } from "@workspace/db/schema";
import { createRequireAuth, type AuthPayload } from "./authCore.js";
import { authPayloadForAccess, loadAuthenticatablePortalUser } from "../lib/authUser.js";
import { isActiveAccessSession } from "../lib/sessionStore.js";
import { signToken, verifyToken } from "../lib/accessToken.js";
import { isAdministrator, isCanonicalUser } from "./authorizationCore.js";

export type { AuthPayload } from "./authCore.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      authTimingMs?: number;
    }
  }
}

export { signToken, verifyToken } from "../lib/accessToken.js";

const authenticateRequest = createRequireAuth({
  verifyToken,
  loadActiveUser: async (payload) => {
    if (!payload.sessionId) return null;
    const access = await loadAuthenticatablePortalUser(payload.userId);
    if (!access) return null;
    if (!await isActiveAccessSession(payload.sessionId, access.user.id)) return null;
    return authPayloadForAccess(access, payload.sessionId);
  },
});

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const startedAt = performance.now();
  await authenticateRequest(req, res, () => {
    req.authTimingMs = Math.round((performance.now() - startedAt) * 100) / 100;
    next();
  });
}

export function requireRole(...roles: Array<"admin" | "edit" | "view">) {
  return (req: Request, res: Response, next: NextFunction) => {
    const compatibilityRole = req.user
      ? isCanonicalUser(req.user)
        ? isAdministrator(req.user) ? "admin" : "view"
        : req.user.role
      : null;
    if (!compatibilityRole || !roles.includes(compatibilityRole)) {
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
