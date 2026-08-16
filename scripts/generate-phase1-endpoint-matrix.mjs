import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routesRoot = path.join(repoRoot, "artifacts", "api-server", "src", "routes");
const outputPath = path.join(repoRoot, "docs", "refactor", "phase-1-endpoint-coverage-matrix.md");

const defaults = {
  attendance: ["Attendance", "PostgreSQL + QUO/PBX call history", "attendance_members, attendance_records, attendance_import_members, attendance_import_records, phone_calls"],
  auth: ["Login and session lifecycle", "PostgreSQL session and user identity", "portal_users, team_agents, auth_sessions, api_rate_limits"],
  backgroundJobs: ["Durable job operations", "PostgreSQL job scheduler", "background_jobs"],
  blockedNumbers: ["Blocked Numbers administration", "PostgreSQL", "blocked_numbers"],
  breaks: ["Attendance breaks", "PostgreSQL", "agent_breaks"],
  csvProxy: ["Legacy CSV proxy", "allowlisted remote CSV", "none"],
  health: ["Deployment health", "process health", "none"],
  liveTransfers: ["Onboarding live transfers", "QUO calls + classification cache", "phone_calls, live_transfer_classifications, live_transfer_state, background_jobs"],
  nsfReadymode: ["Missed / No Callback NSF queue", "PostgreSQL queue + PBX/QUO", "nsf_readymode_queue, phone_calls"],
  obAnalytics: ["Onboarding analytics", "PostgreSQL QUO call history", "phone_calls, onboarding_classifications"],
  obReport: ["Onboarding report", "QUO calls + classification cache", "phone_calls, onboarding_classifications, onboarding_report_state, background_jobs"],
  qa: ["Retention QA", "PostgreSQL QUO calls + QA records", "phone_calls, qa_reviews, manager_qa_tasks, qa_biweekly_runs, background_jobs"],
  quo: ["Metrics dashboards and Phones / Quo", "QUO/OpenPhone API + PostgreSQL", "phone_calls, phone_sync_state, durable_runtime_state, blocked_numbers, background_jobs"],
  quoWebhook: ["QUO webhook ingestion", "signed QUO/OpenPhone webhook", "webhook_inbox, phone_calls, durable_runtime_state"],
  readymode: ["Metrics dashboards and Phones / ReadyMode", "ReadyMode CSV + retained HTML probe + PostgreSQL uploads", "readymode_uploads"],
  samia: ["Samia", "Anthropic + operational APIs", "samia_conversations and operational tables"],
  sheets: ["Backend Statistics and metrics file tabs", "authenticated Google Sheets JSON API", "none"],
  teamAgents: ["Agent Roster and authorization directory", "PostgreSQL", "team_agents, portal_users"],
  users: ["User Management and access control", "PostgreSQL", "portal_users, portal_user_team_grants, portal_user_tab_grants, auth_sessions"],
  violations: ["Violations", "Google Sheets + QUO/PBX call history", "phone_calls, violation_verifications"],
  vos: ["Metrics dashboards and Phones / PBX", "authenticated PBX web session + JSON API; PostgreSQL history", "phone_calls, pbx_missed_calls, durable_runtime_state, background_jobs"],
};

const publicRoutes = new Map([
  ["GET /healthz", "public health probe"],
  ["POST /auth/login", "public credential exchange with rate limits"],
  ["POST /auth/password-upgrade", "short-lived signed upgrade challenge"],
  ["POST /auth/refresh", "HttpOnly refresh cookie"],
  ["POST /auth/logout", "refresh cookie/session revocation"],
  ["POST /quo/webhook", "verified provider signature"],
  ["POST /openphone/webhook", "verified provider signature"],
  ["GET /qa/biweekly-run", "CRON_SECRET"],
  ["GET /jobs/cron", "CRON_SECRET"],
  ["POST /ob-report/import", "OB_IMPORT_SECRET"],
]);

const exportRoutes = new Set(["GET /qa/download", "GET /ob-report/download", "GET /ob-analytics/download", "GET /live-transfers/download"]);
const exportParityRoutes = new Set(["GET /ob-analytics/download"]);
const importRoutes = new Set(["POST /attendance/import", "POST /readymode/upload", "POST /ob-report/import"]);
const authenticationRoutes = new Set(["POST /auth/login", "POST /auth/password-upgrade", "POST /auth/refresh", "POST /auth/logout", "GET /auth/me"]);
const fullStackAuthenticationRoutes = new Set(["POST /auth/login", "POST /auth/refresh", "POST /auth/logout", "GET /auth/me"]);
const accessControlRoutes = new Set([
  "GET /users", "POST /users", "PATCH /users/:id", "DELETE /users/:id",
  "GET /team-agents", "POST /team-agents", "PATCH /team-agents/:id", "DELETE /team-agents/:id",
]);
const directNumberRoutePatterns = [
  /^GET \/sheet$/,
  /^GET \/(?:quo|vos|readymode)\/(?:stats|calls|live|lines|all-lines|line-stats|missed-no-callback|missed-hourly|missed-daily|missed-breakdown|callback-review)$/,
  /^GET \/attendance(?:\/call-logs|\/agent-contacts)?$/,
  /^GET \/violations(?:\/verified)?$/,
  /^GET \/qa\/(?:stats|reviews|reviews\/:id|tasks|runs\/latest|agents)$/,
  /^GET \/(?:ob-report\/status|ob-analytics|live-transfers\/status)$/,
];
const goldenNumberRoutes = new Set([
  "GET /sheet",
  "GET /quo/stats",
  "GET /quo/calls",
  "GET /quo/live",
  "GET /vos/stats",
  "GET /vos/missed-hourly",
  "GET /vos/missed-daily",
  "GET /vos/callback-review",
  "GET /readymode/stats",
  "GET /attendance",
  "GET /violations",
  "GET /ob-report/status",
  "GET /ob-analytics",
]);

function authorizationFor(key, route) {
  if (publicRoutes.has(key)) return publicRoutes.get(key);
  if (route.startsWith("/samia")) return "administrator";
  if (route.startsWith("/users") || /^(?:POST|PATCH|DELETE) \/team-agents/.test(key)) return "administrator";
  if (route.startsWith("/jobs")) return "administrator";
  if (route.includes("/debug/") || route.endsWith("/probe") || route.endsWith("/session/reset")) return "administrator";
  if (/^(?:POST|DELETE) \/(?:blocked-numbers|breaks)/.test(key)) return "admin/edit compatibility role or canonical edit permission";
  if (route.startsWith("/attendance")) return "attendance permission; mutation permissions vary by route";
  if (route.startsWith("/qa")) return key.startsWith("GET ") && !route.includes("runs/latest") ? "QA tab + view_metrics" : "administrator";
  if (route.startsWith("/ob-") || route.startsWith("/live-transfers")) return key.startsWith("GET ") ? "Onboarding tab grant" : "administrator";
  if (route.startsWith("/vos")) return route.includes("missed") || route.includes("callback") ? "matching dashboard tab/permission" : "visible metrics tab; controls are administrator";
  if (route.startsWith("/quo") || route.startsWith("/readymode") || route === "/sheet") return "visible metrics/source tab; controls are administrator";
  if (route.startsWith("/violations")) return key.startsWith("DELETE ") ? "administrator" : "Violations tab + view_metrics";
  if (route.startsWith("/nsf/readymode-queue")) return key.startsWith("POST ") && route === "/nsf/readymode-queue" ? "administrator" : "full NSF access + missed tab";
  if (route === "/team-agents") return "view_metrics or view_attendance";
  return "authenticated; explicit central policy (unmapped routes default to administrator)";
}

function coverageFor(key, sourceName) {
  if (authenticationRoutes.has(key)) {
    const tests = key === "POST /auth/password-upgrade"
      ? ["passwordUpgrade.integration.test.ts"]
      : ["dashboard-full-stack.spec.ts", "loginSessions.integration.test.ts"];
    return [fullStackAuthenticationRoutes.has(key) ? "integration; browser" : "integration", tests.join("; "), ""];
  }
  if (exportRoutes.has(key)) {
    const parity = exportParityRoutes.has(key);
    return [parity ? "integration; browser; export parity" : "integration; browser", parity ? "dashboard-full-stack.spec.ts; exportParity.test.ts" : "dashboard-full-stack.spec.ts", ""];
  }
  if (importRoutes.has(key)) return ["authorization", "dashboard-full-stack.spec.ts; authorization.test.ts", "Direct HTTP boundary protection; success-path mutation is intentionally outside read-only acceptance."];
  if (accessControlRoutes.has(key)) return ["integration; authorization", "canonicalAccess.integration.test.ts; teamAgents.integration.test.ts; dashboard-full-stack.spec.ts", ""];
  if (directNumberRoutePatterns.some((pattern) => pattern.test(key))) {
    const golden = goldenNumberRoutes.has(key);
    return [golden ? "integration; golden; browser" : "integration; browser", golden ? "dashboard-full-stack.spec.ts; goldenResponses.test.ts" : "dashboard-full-stack.spec.ts", ""];
  }
  if (sourceName === "samia") return ["authorization; excluded", "authorization.test.ts", "Samia business behavior is explicitly outside this acceptance task; only its existing access boundary is protected here."];
  if (key === "GET /healthz") return ["integration", "dashboard-full-stack.spec.ts", ""];
  if (key === "POST /quo/webhook" || key === "POST /openphone/webhook") return ["integration", "webhooks.integration.test.ts", ""];
  return ["authorization; inventory only", "inventoryCoverage.test.ts; authorization.test.ts", "Route declaration and authorization are checked, but no Phase 1 response-body regression assertion exists."];
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

const routeFiles = (await readdir(routesRoot)).filter((name) => name.endsWith(".ts") && name !== "index.ts").sort();
const endpoints = [];
for (const filename of routeFiles) {
  const sourceName = path.basename(filename, ".ts");
  if (!defaults[sourceName]) continue;
  const source = await readFile(path.join(routesRoot, filename), "utf8");
  for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)) {
    const method = match[1].toUpperCase();
    const route = match[2];
    const key = `${method} ${route}`;
    const [workflow, dataSource, tables] = defaults[sourceName];
    const [coverage, tests, reason] = coverageFor(key, sourceName);
    endpoints.push({ method, route, workflow, dataSource, tables, authorization: authorizationFor(key, route), tests, coverage, reason });
  }
}
endpoints.sort((left, right) => left.route.localeCompare(right.route) || left.method.localeCompare(right.method));

const direct = endpoints.filter(({ coverage }) => !coverage.includes("inventory only") && !coverage.includes("excluded")).length;
const inventoryOnly = endpoints.filter(({ coverage }) => coverage.includes("inventory only")).length;
const excluded = endpoints.filter(({ coverage }) => coverage.includes("excluded")).length;
const rows = endpoints.map((endpoint) => `| ${endpoint.method} | \`${endpoint.route}\` | ${escapeCell(endpoint.workflow)} | ${escapeCell(endpoint.dataSource)} | ${escapeCell(endpoint.tables)} | ${escapeCell(endpoint.authorization)} | ${escapeCell(endpoint.tests)} | ${escapeCell(endpoint.coverage)} | ${escapeCell(endpoint.reason || "—")} |`).join("\n");
const document = `# Phase 1 endpoint coverage matrix

Generated from the route declarations under \`artifacts/api-server/src/routes\` by \`scripts/generate-phase1-endpoint-matrix.mjs\`. \`inventoryCoverage.test.ts\` fails when a declared method/path is missing from this matrix.

Coverage summary at generation time: **${endpoints.length} declared endpoints**, **${direct} with direct Phase 1 behavior/HTTP protection**, **${inventoryOnly} inventory-only beyond their central authorization assertion**, and **${excluded} explicitly excluded from business-behavior hardening**. “Inventory only” is not direct response or calculation regression coverage. A row may include authorization coverage and still remain inventory-only for its response body.

All private routes are also protected by the central default-deny middleware and \`authorization.test.ts\`. The coverage column describes the strongest direct Phase 1 evidence, not every repository test that may touch the route.

| Method | Route | Dashboard/workflow | Data source | Database tables | Authorization policy | Test protecting it | Coverage type | Exclusion/inventory reason |
|---|---|---|---|---|---|---|---|---|
${rows}
`;
await writeFile(outputPath, document, "utf8");
process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)} with ${endpoints.length} endpoints.\n`);
