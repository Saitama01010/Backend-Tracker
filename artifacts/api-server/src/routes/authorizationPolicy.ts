import type { Permission } from "@workspace/db/schema";
import type { AuthPayload } from "../middleware/authCore.js";
import {
  canViewAnyTab,
  canViewTab,
  canAccessDateRange,
  hasAnyPermission,
  hasPermission,
  type DashboardTab,
} from "../middleware/authorizationCore.js";
import { isPublicApiRoute } from "./apiPolicy.js";

export interface ApiAuthorizationDecision {
  allowed: boolean;
  matched: boolean;
  requirement: string;
}

type Predicate = (user: AuthPayload) => boolean;
type RoutePolicy = {
  methods: readonly string[];
  path: RegExp;
  requirement: string;
  allows: Predicate;
};

const admin: Predicate = (user) => user.role === "admin";
const roles = (...allowed: AuthPayload["role"][]): Predicate => (user) => allowed.includes(user.role);
const permission = (value: Permission): Predicate => (user) => hasPermission(user, value);
const anyPermission = (...values: Permission[]): Predicate => (user) => hasAnyPermission(user, values);
const tab = (value: DashboardTab): Predicate => (user) => hasPermission(user, "view_metrics") && canViewTab(user, value);
const anyMetricTab: Predicate = (user) => hasPermission(user, "view_metrics")
  && canViewAnyTab(user, ["retention", "nsf", "cs", "rmk"]);
const sheetData: Predicate = (user) => canViewTab(user, "backend-stats") || anyMetricTab(user);
const missedManager: Predicate = (user) => tab("missed-no-cb")(user) && hasPermission(user, "view_missed_tables");

export const PRIVATE_API_AUTHORIZATION_POLICIES: readonly RoutePolicy[] = [
  { methods: ["GET"], path: /^\/auth\/me$/, requirement: "active authenticated user", allows: () => true },
  { methods: ["GET"], path: /^\/jobs$/, requirement: "admin background-job observability", allows: admin },
  { methods: ["GET"], path: /^\/jobs\/scheduler-health$/, requirement: "admin scheduler observability", allows: admin },
  { methods: ["GET"], path: /^\/jobs\/\d+$/, requirement: "admin background-job observability", allows: admin },

  { methods: ["GET", "POST"], path: /^\/users$/, requirement: "admin", allows: admin },
  { methods: ["PATCH", "DELETE"], path: /^\/users\/\d+$/, requirement: "admin", allows: admin },
  { methods: ["GET", "POST"], path: /^\/samia(?:\/.*)?$/, requirement: "admin", allows: admin },

  { methods: ["GET"], path: /^\/quo\/(?:lines|all-lines|line-stats|sync-state)$/, requirement: "admin phone-system view", allows: admin },
  { methods: ["POST"], path: /^\/quo\/sync$/, requirement: "admin phone-system view", allows: admin },
  { methods: ["GET"], path: /^\/quo\/stats$/, requirement: "view_metrics and a visible team metrics tab", allows: anyMetricTab },
  { methods: ["GET"], path: /^\/quo\/calls$/, requirement: "view_metrics and authorized requested team", allows: anyMetricTab },
  { methods: ["GET"], path: /^\/quo\/live$/, requirement: "view_metrics or view_attendance", allows: anyPermission("view_metrics", "view_attendance") },

  { methods: ["POST"], path: /^\/vos\/refresh$/, requirement: "admin PBX system control", allows: admin },
  { methods: ["GET"], path: /^\/vos\/stats$/, requirement: "view_metrics and a visible team metrics tab", allows: anyMetricTab },
  { methods: ["GET"], path: /^\/vos\/live$/, requirement: "view_metrics or view_attendance", allows: anyPermission("view_metrics", "view_attendance") },
  { methods: ["GET"], path: /^\/vos\/missed-no-callback$/, requirement: "view_metrics and missed-no-callback tab", allows: tab("missed-no-cb") },
  { methods: ["GET"], path: /^\/vos\/(?:missed-hourly|missed-daily|missed-breakdown)$/, requirement: "view_missed_tables and missed-no-callback tab", allows: missedManager },
  { methods: ["GET"], path: /^\/vos\/callback-review$/, requirement: "view_metrics and callback-review tab", allows: tab("callback-review") },
  { methods: ["GET"], path: /^\/vos\/debug\/(?:calls|proxy)$/, requirement: "admin", allows: admin },

  { methods: ["GET"], path: /^\/attendance$/, requirement: "view_attendance", allows: permission("view_attendance") },
  { methods: ["GET"], path: /^\/attendance\/(?:call-logs|agent-contacts)$/, requirement: "view_attendance", allows: permission("view_attendance") },
  { methods: ["POST", "PATCH"], path: /^\/attendance\/members(?:\/\d+)?$/, requirement: "manage_members", allows: permission("manage_members") },
  { methods: ["PUT"], path: /^\/attendance\/record$/, requirement: "edit_attendance", allows: permission("edit_attendance") },
  { methods: ["POST"], path: /^\/attendance\/(?:set|auto-mark)$/, requirement: "edit_attendance", allows: permission("edit_attendance") },
  { methods: ["POST"], path: /^\/attendance\/import$/, requirement: "manage_members", allows: permission("manage_members") },

  { methods: ["GET"], path: /^\/sheet$/, requirement: "backend-stats or visible team metrics tab", allows: sheetData },
  { methods: ["GET"], path: /^\/csv-proxy$/, requirement: "admin-only legacy endpoint; dashboard callers use /sheet", allows: admin },
  { methods: ["GET"], path: /^\/readymode\/stats$/, requirement: "view_metrics and a visible team metrics tab", allows: anyMetricTab },
  { methods: ["GET"], path: /^\/readymode\/probe$/, requirement: "admin", allows: admin },
  { methods: ["POST"], path: /^\/readymode\/upload$/, requirement: "admin or edit role", allows: roles("admin", "edit") },
  { methods: ["POST"], path: /^\/readymode\/session\/reset$/, requirement: "admin ReadyMode system control", allows: admin },

  { methods: ["POST"], path: /^\/nsf\/readymode-queue$/, requirement: "admin Samia workflow", allows: admin },
  { methods: ["GET"], path: /^\/nsf\/readymode-queue$/, requirement: "NSF-capable missed-no-callback tab", allows: (user) => tab("missed-no-cb")(user) && (!user.teamAccess || user.teamAccess === "nsf") },
  { methods: ["POST"], path: /^\/nsf\/readymode-queue\/(?:\d+\/done|done-by-number)$/, requirement: "NSF-capable missed-no-callback tab", allows: (user) => tab("missed-no-cb")(user) && (!user.teamAccess || user.teamAccess === "nsf") },

  { methods: ["GET"], path: /^\/violations(?:\/verified)?$/, requirement: "view_metrics and violations tab", allows: tab("violations") },
  { methods: ["POST"], path: /^\/violations\/verify$/, requirement: "view_metrics and violations tab", allows: tab("violations") },
  { methods: ["DELETE"], path: /^\/violations\/verify$/, requirement: "admin correction", allows: admin },

  { methods: ["POST"], path: /^\/qa\/(?:evaluate|biweekly-run|process|assign-weekly)$/, requirement: "admin", allows: admin },
  { methods: ["GET"], path: /^\/qa\/runs\/latest$/, requirement: "admin", allows: admin },
  { methods: ["POST"], path: /^\/qa\/tasks\/[^/]+\/resolve$/, requirement: "admin", allows: admin },
  { methods: ["GET"], path: /^\/qa\/(?:biweekly-run|stats|download|reviews|tasks|agents)$/, requirement: "view_metrics and QA tab (cron route is independently authenticated)", allows: tab("qa") },
  { methods: ["GET"], path: /^\/qa\/reviews\/[^/]+$/, requirement: "view_metrics and QA tab", allows: tab("qa") },

  { methods: ["GET"], path: /^\/ob-(?:report\/(?:status|download)|analytics(?:\/download)?)$/, requirement: "view_metrics and onboarding tab", allows: tab("onboarding") },
  { methods: ["POST"], path: /^\/ob-report\/refresh$/, requirement: "admin AI and sync control", allows: admin },
  { methods: ["GET"], path: /^\/live-transfers\/(?:status|download)$/, requirement: "view_metrics and onboarding tab", allows: tab("onboarding") },
  { methods: ["POST"], path: /^\/live-transfers\/refresh$/, requirement: "admin AI and sync control", allows: admin },

  { methods: ["GET"], path: /^\/team-agents$/, requirement: "view_metrics or view_attendance", allows: anyPermission("view_metrics", "view_attendance") },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/team-agents(?:\/\d+)?$/, requirement: "admin", allows: admin },
  { methods: ["GET"], path: /^\/blocked-numbers$/, requirement: "admin panel", allows: admin },
  { methods: ["POST", "DELETE"], path: /^\/blocked-numbers(?:\/[^/]+)?$/, requirement: "admin or edit role (existing backend workflow)", allows: roles("admin", "edit") },
  { methods: ["GET"], path: /^\/breaks$/, requirement: "view_attendance", allows: permission("view_attendance") },
  { methods: ["POST", "DELETE"], path: /^\/breaks(?:\/(?:start|end|log|\d+))$/, requirement: "admin or edit role (existing backend workflow)", allows: roles("admin", "edit") },
] as const;

export function authorizeApiRoute(method: string, path: string, user: AuthPayload | undefined): ApiAuthorizationDecision {
  if (isPublicApiRoute(method, path)) {
    return { allowed: true, matched: true, requirement: "independently authenticated public integration" };
  }
  if (!user) return { allowed: false, matched: true, requirement: "active authenticated user" };

  const normalizedMethod = method.toUpperCase();
  const policy = PRIVATE_API_AUTHORIZATION_POLICIES.find(({ methods, path: routePath }) =>
    methods.includes(normalizedMethod) && routePath.test(path));
  if (!policy) {
    return { allowed: user.role === "admin", matched: false, requirement: "unmapped routes default to admin" };
  }
  return { allowed: policy.allows(user), matched: true, requirement: policy.requirement };
}

const LOCKED_RANGE_ROUTES = [
  /^GET \/quo\/(?:stats|calls)$/,
  /^GET \/readymode\/stats$/,
  /^GET \/attendance$/,
  /^GET \/violations$/,
  /^GET \/vos\/callback-review$/,
  /^GET \/qa\/(?:stats|download|reviews|agents)$/,
  /^GET \/ob-report\/(?:status|download)$/,
  /^GET \/ob-analytics(?:\/download)?$/,
  /^GET \/live-transfers\/(?:status|download)$/,
  /^GET \/breaks$/,
] as const;

type RequestValues = Record<string, unknown>;

export function authorizeApiDateParameters(
  method: string,
  path: string,
  user: AuthPayload | undefined,
  query: RequestValues = {},
  body: RequestValues = {},
  now = new Date(),
): boolean {
  if (!user || user.role === "admin" || !user.lockToToday) return true;
  const key = `${method.toUpperCase()} ${path}`;
  const requiresRange = LOCKED_RANGE_ROUTES.some((pattern) => pattern.test(key));
  const from = typeof query["from"] === "string" ? query["from"] : typeof body["from"] === "string" ? body["from"] : undefined;
  const to = typeof query["to"] === "string" ? query["to"] : typeof body["to"] === "string" ? body["to"] : undefined;
  if (requiresRange && (!from || !to)) return false;

  const values = [from, to];
  for (const name of ["date", "breakStart", "breakEnd"] as const) {
    const value = typeof query[name] === "string" ? query[name] : typeof body[name] === "string" ? body[name] : undefined;
    values.push(value);
  }
  const requested = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  return requested.length === 0 || canAccessDateRange(user, requested, now);
}
