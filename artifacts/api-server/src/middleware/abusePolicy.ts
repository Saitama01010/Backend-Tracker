import type { Request } from "express";

export interface ProtectedAction {
  key: string;
  limit: number;
  windowSeconds: number;
}

type ActionRule = ProtectedAction & {
  method: string;
  path: RegExp;
  when?: (req: Request) => boolean;
};

const ACTION_RULES: readonly ActionRule[] = [
  { method: "POST", path: /^\/quo\/sync$/, key: "quo-sync", limit: 12, windowSeconds: 5 * 60 },
  { method: "POST", path: /^\/vos\/refresh$/, key: "vos-refresh", limit: 12, windowSeconds: 5 * 60 },
  { method: "POST", path: /^\/readymode\/session\/reset$/, key: "readymode-session-reset", limit: 6, windowSeconds: 10 * 60 },
  { method: "POST", path: /^\/readymode\/upload$/, key: "readymode-upload", limit: 10, windowSeconds: 10 * 60 },
  { method: "POST", path: /^\/ob-report\/refresh$/, key: "onboarding-refresh", limit: 12, windowSeconds: 5 * 60 },
  { method: "POST", path: /^\/live-transfers\/refresh$/, key: "live-transfer-refresh", limit: 12, windowSeconds: 5 * 60 },
  { method: "POST", path: /^\/qa\/(?:evaluate|biweekly-run|process|assign-weekly)$/, key: "qa-expensive-action", limit: 20, windowSeconds: 10 * 60 },
  { method: "POST", path: /^\/attendance\/(?:import|auto-mark)$/, key: "attendance-bulk-action", limit: 12, windowSeconds: 10 * 60 },
  { method: "POST", path: /^\/samia\/chat$/, key: "samia-chat", limit: 30, windowSeconds: 5 * 60 },
  { method: "POST", path: /^\/users$/, key: "account-password-create", limit: 10, windowSeconds: 60 * 60 },
  {
    method: "PATCH",
    path: /^\/users\/\d+$/,
    key: "account-password-change",
    limit: 10,
    windowSeconds: 60 * 60,
    when: (req) => typeof (req.body as Record<string, unknown> | undefined)?.["password"] === "string",
  },
] as const;

export function protectedActionForRequest(method: string, path: string, req?: Request): ProtectedAction | null {
  const normalizedMethod = method.toUpperCase();
  const rule = ACTION_RULES.find((candidate) =>
    candidate.method === normalizedMethod && candidate.path.test(path) && (!candidate.when || (!!req && candidate.when(req))));
  return rule ? { key: rule.key, limit: rule.limit, windowSeconds: rule.windowSeconds } : null;
}
