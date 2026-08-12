export type PublicApiClassification =
  | "public health/login route"
  | "cookie-authenticated session route"
  | "verified webhook"
  | "cron/server-to-server route";

export interface PublicApiRoute {
  method: "GET" | "HEAD" | "POST";
  path: string;
  classification: PublicApiClassification;
  reason: string;
}

export const PUBLIC_API_ROUTES: readonly PublicApiRoute[] = [
  {
    method: "GET",
    path: "/healthz",
    classification: "public health/login route",
    reason: "Deployment health probes must work before browser authentication.",
  },
  {
    method: "HEAD",
    path: "/healthz",
    classification: "public health/login route",
    reason: "Header-only deployment health probes must work before browser authentication.",
  },
  {
    method: "POST",
    path: "/auth/login",
    classification: "public health/login route",
    reason: "Users need this endpoint to obtain their bearer token.",
  },
  {
    method: "POST",
    path: "/auth/refresh",
    classification: "cookie-authenticated session route",
    reason: "Expired access tokens renew through a validated HttpOnly refresh-session cookie.",
  },
  {
    method: "POST",
    path: "/auth/logout",
    classification: "cookie-authenticated session route",
    reason: "Logout must revoke or clear the refresh session even when the access token has expired.",
  },
  {
    method: "POST",
    path: "/quo/webhook",
    classification: "verified webhook",
    reason: "OpenPhone authenticates this integration with its signed webhook header.",
  },
  {
    method: "POST",
    path: "/openphone/webhook",
    classification: "verified webhook",
    reason: "OpenPhone authenticates this compatibility endpoint with its signed webhook header.",
  },
  {
    method: "GET",
    path: "/qa/biweekly-run",
    classification: "cron/server-to-server route",
    reason: "The scheduler authenticates with CRON_SECRET instead of a browser session.",
  },
  {
    method: "GET",
    path: "/jobs/cron",
    classification: "cron/server-to-server route",
    reason: "The durable scheduler authenticates with CRON_SECRET instead of a browser session.",
  },
  {
    method: "POST",
    path: "/ob-report/import",
    classification: "cron/server-to-server route",
    reason: "The controlled importer authenticates with OB_IMPORT_SECRET instead of a browser session.",
  },
] as const;

const publicRouteKeys = new Set(PUBLIC_API_ROUTES.map(({ method, path }) => `${method} ${path}`));

export function isPublicApiRoute(method: string, path: string): boolean {
  return publicRouteKeys.has(`${method.toUpperCase()} ${path}`);
}
