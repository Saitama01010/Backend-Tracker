import type { Request, Response, NextFunction } from "express";
import type { Permission } from "@workspace/db/schema";
import { createRequireAuth, type AuthPayload } from "./authCore.js";
import { authPayloadForUser, loadActivePortalUser } from "../lib/authUser.js";
import { isActiveAccessSession } from "../lib/sessionStore.js";
import { signToken, verifyToken } from "../lib/accessToken.js";

export type { AuthPayload } from "./authCore.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

export { signToken, verifyToken } from "../lib/accessToken.js";

export const requireAuth = createRequireAuth({
  verifyToken,
  loadActiveUser: async (payload) => {
    const user = await loadActivePortalUser(payload.userId);
    if (!user) return null;
    if (payload.sessionId && !await isActiveAccessSession(payload.sessionId, user.id)) return null;
    return authPayloadForUser(user, payload.sessionId);
  },
});

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
