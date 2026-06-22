import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { Permission } from "@workspace/db/schema";

export interface AuthPayload {
  userId: number;
  username: string;
  role: "admin" | "edit" | "view";
  permissions: Permission[];
  teamAccess?: "retention" | "nsf" | "cs" | null;
  allowedTabs?: string[] | null;
  allowedAgents?: string[] | null;
  allowedSubTabs?: string[] | null;
  lockToToday?: boolean;
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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers["authorization"];
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    req.user = jwt.verify(token, secret()) as AuthPayload;
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
