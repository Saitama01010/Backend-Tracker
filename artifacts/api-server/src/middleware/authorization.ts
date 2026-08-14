import type { NextFunction, Request, Response } from "express";
import type { Permission } from "@workspace/db/schema";
import {
  canAccessAgent,
  canAccessDateRange,
  canAccessMetricTeam,
  canViewAnyTab,
  hasAnyPermission,
  isAdministrator,
  type DashboardTab,
  type MetricTeam,
} from "./authorizationCore.js";

function forbidden(res: Response): void {
  res.status(403).json({ error: "Forbidden" });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !isAdministrator(req.user)) return forbidden(res);
  next();
}

export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasAnyPermission(req.user, permissions)) return forbidden(res);
    next();
  };
}

export function requireTabAccess(...tabs: DashboardTab[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !canViewAnyTab(req.user, tabs)) return forbidden(res);
    next();
  };
}

export function requireTeamAccess(resolveTeam: (req: Request) => MetricTeam | null | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const team = resolveTeam(req);
    if (!req.user || !team || !canAccessMetricTeam(req.user, team)) return forbidden(res);
    next();
  };
}

export function requireAgentAccess(resolveAgent: (req: Request) => { name: string; aliases?: string[] } | null | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const agent = resolveAgent(req);
    if (!req.user || !agent || !canAccessAgent(req.user, agent.name, agent.aliases)) return forbidden(res);
    next();
  };
}

export function requireDateRangeAccess(resolveValues: (req: Request) => Array<string | undefined | null>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !canAccessDateRange(req.user, resolveValues(req))) return forbidden(res);
    next();
  };
}
