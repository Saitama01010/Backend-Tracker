import type { NextFunction, Request, Response } from "express";
import type {
  CanonicalAccessRole,
  CanonicalDashboardTab,
  Permission,
  TeamAccess,
  TeamSlug,
} from "@workspace/db/schema";

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
  accessModel?: "legacy" | "canonical";
  accessRole?: CanonicalAccessRole | null;
  selfAgentId?: number | null;
  selfAgentName?: string | null;
  selfAgentTeam?: TeamSlug | null;
  primaryTeam?: TeamSlug | null;
  fullTeamAccess?: TeamSlug[];
  tabGrants?: CanonicalDashboardTab[];
  sessionId?: string;
}

export type SessionAuthPayload = AuthPayload & { sessionId: string };

interface AuthenticatedRequest extends Request {
  user?: AuthPayload;
}

export interface AuthenticationDependencies {
  verifyToken: (token: string) => AuthPayload;
  loadActiveUser: (claims: AuthPayload) => Promise<AuthPayload | null>;
}

export function createRequireAuth({ verifyToken, loadActiveUser }: AuthenticationDependencies) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user) {
      next();
      return;
    }

    const header = req.headers["authorization"];
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const claims = verifyToken(token);
      const user = await loadActiveUser(claims);
      if (!user) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
      }

      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}
