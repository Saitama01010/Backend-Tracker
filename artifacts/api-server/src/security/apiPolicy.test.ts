import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PUBLIC_API_ROUTES, isPublicApiRoute } from "../routes/apiPolicy.js";

test("only the exact reviewed health, login, webhook, cron, and import routes are public", () => {
  for (const route of PUBLIC_API_ROUTES) {
    assert.equal(isPublicApiRoute(route.method, route.path), true, `${route.method} ${route.path}`);
  }

  for (const [method, path] of [
    ["GET", "/auth/me"],
    ["GET", "/quo/stats"],
    ["POST", "/quo/sync"],
    ["GET", "/vos/stats"],
    ["GET", "/attendance"],
    ["GET", "/sheet"],
    ["GET", "/readymode/stats"],
    ["GET", "/ob-report/status"],
    ["GET", "/ob-analytics"],
    ["GET", "/violations"],
    ["GET", "/qa/stats"],
    ["GET", "/samia/diagnostics"],
    ["GET", "/users"],
    ["GET", "/future-private-route"],
  ]) {
    assert.equal(isPublicApiRoute(method, path), false, `${method} ${path}`);
  }
});

test("method, path, and prefix variants cannot bypass the public allowlist", () => {
  assert.equal(isPublicApiRoute("POST", "/healthz"), false);
  assert.equal(isPublicApiRoute("GET", "/auth/login"), false);
  assert.equal(isPublicApiRoute("POST", "/quo/webhook/extra"), false);
  assert.equal(isPublicApiRoute("POST", "/ob-report/import/extra"), false);
  assert.equal(isPublicApiRoute("GET", "/QA/biweekly-run"), false);
});

test("the default-private guard is mounted before every API router", async () => {
  const source = await readFile(new URL("../routes/index.ts", import.meta.url), "utf8");
  const guard = source.indexOf("router.use(defaultPrivateApiAuthentication)");
  const firstRouter = source.indexOf("router.use(healthRouter)");

  assert.ok(guard >= 0, "default-private guard must be mounted");
  assert.ok(firstRouter > guard, "default-private guard must run before public and private routers");
});
