import { expect, test, type Page } from "@playwright/test";

const fixedRange = {
  from: "2026-08-16T07:00:00.000Z",
  to: "2026-08-17T06:59:59.999Z",
};

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Email").fill("phase-one-admin@example.test");
  await page.locator("input#tracker-password").fill("Phase1-Only!2026");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Backend Tracker" })).toBeVisible();
}

async function authenticatedFetch(page: Page, path: string, init?: { method?: string; body?: unknown }) {
  return page.evaluate(async ({ path, init }) => {
    const token = localStorage.getItem("tracker_token") ?? sessionStorage.getItem("tracker_token");
    const response = await fetch(path, {
      method: init?.method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      bodyPrefix: new TextDecoder().decode(bytes.slice(0, 160)),
      byteLength: bytes.byteLength,
      zipMagic: bytes[0] === 0x50 && bytes[1] === 0x4b,
    };
  }, { path, init });
}

test("real frontend, Express API, session, authorization, PostgreSQL, sources, filters, refresh, tables, and exports work together", async ({ page, request }) => {
  const unexpectedApiFailures: string[] = [];
  const pageErrors: string[] = [];
  const apiRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (req) => {
    if (req.url().includes("/api/")) apiRequests.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) {
      unexpectedApiFailures.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    }
  });

  const anonymous = await request.get("http://127.0.0.1:8080/api/quo/stats");
  expect(anonymous.status()).toBe(401);
  await login(page);

  const refresh = await page.evaluate(async () => {
    const response = await fetch("/api/auth/refresh", { method: "POST" });
    const body = await response.json() as { token?: string };
    const me = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${body.token ?? ""}` } });
    return { refreshStatus: response.status, meStatus: me.status, hasToken: typeof body.token === "string" };
  });
  expect(refresh).toEqual({ refreshStatus: 200, meStatus: 200, hasToken: true });

  await page.getByTestId("tab-retention").click();
  const panel = page.getByTestId("active-metrics-panel");
  await expect(panel).toHaveAttribute("data-active-tab", "retention");
  await expect.poll(async () => /\b[1-9]\d*\b/.test((await panel.innerText()).replace(/,/g, ""))).toBe(true);
  const today = panel.getByTestId("button-today");
  if (await today.count()) await today.first().click();
  const refreshButton = panel.getByTestId("button-refresh");
  if (await refreshButton.count()) await refreshButton.first().click();
  for (const name of ["By call", "By files", "By day"]) {
    const tab = panel.getByRole("tab", { name, exact: true });
    await tab.first().click();
    await expect(tab.first()).toHaveAttribute("data-state", "active");
  }

  await page.getByTestId("tab-callback-review").click();
  await expect(page.getByRole("button", { name: "All Teams", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retention", exact: true }).last().click();
  await page.getByRole("button", { name: "All Teams", exact: true }).click();

  await page.getByTestId("tab-retention").click();
  await panel.getByRole("tab", { name: "By files", exact: true }).click();
  const csvDownload = page.waitForEvent("download");
  await panel.getByTestId("button-export-csv").click();
  await expect((await csvDownload).suggestedFilename()).toMatch(/^files_.*\.csv$/);

  await page.getByRole("button", { name: "Choose dashboard view" }).click();
  await page.getByRole("option", { name: /Phones/i }).click();
  for (const tabName of ["Quo Lines", "PBX", "ReadyMode"]) {
    await page.getByRole("button", { name: tabName, exact: true }).first().click();
    await expect.poll(async () => /\b[1-9]\d*\b/.test((await page.locator("main").innerText()).replace(/,/g, ""))).toBe(true);
  }

  await page.getByRole("button", { name: "Choose dashboard view" }).click();
  await page.getByRole("option", { name: /Backend Stats/i }).click();
  await expect(page.getByRole("heading", { name: "Backend Statistics" })).toBeVisible();
  await expect(page.getByText("Total Files")).toBeVisible();

  const directNumberEndpoints = [
    "/api/sheet?id=1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o&gid=837339339",
    "/api/quo/lines",
    "/api/quo/all-lines",
    `/api/quo/line-stats?lineId=line-ret&from=${encodeURIComponent(fixedRange.from)}&to=${encodeURIComponent(fixedRange.to)}`,
    `/api/quo/stats?from=${encodeURIComponent(fixedRange.from)}&to=${encodeURIComponent(fixedRange.to)}`,
    `/api/quo/calls?from=${encodeURIComponent(fixedRange.from)}&to=${encodeURIComponent(fixedRange.to)}&team=retention`,
    "/api/quo/live",
    "/api/vos/stats",
    "/api/vos/live",
    "/api/vos/missed-no-callback",
    "/api/vos/missed-hourly?date=2026-08-16",
    "/api/vos/missed-daily?from=2026-08-16&to=2026-08-16",
    "/api/vos/missed-breakdown?date=2026-08-16",
    "/api/vos/callback-review?from=2026-08-16&to=2026-08-16",
    "/api/readymode/stats?from=2026-08-16&to=2026-08-16",
    "/api/attendance?date=2026-08-16",
    "/api/attendance/call-logs?date=2026-08-16",
    "/api/attendance/agent-contacts?agent=Agent%20Alpha&date=2026-08-16",
    "/api/violations?from=2026-08-16&to=2026-08-16",
    "/api/violations/verified",
    "/api/ob-analytics?from=2026-08-16&to=2026-08-16",
    "/api/ob-report/status?from=2026-08-16&to=2026-08-16",
    "/api/live-transfers/status?from=2026-08-16&to=2026-08-16",
    "/api/qa/stats?from=2026-08-16&to=2026-08-16",
    "/api/qa/reviews?from=2026-08-16&to=2026-08-16",
    "/api/qa/reviews/phase1-call-1",
    "/api/qa/tasks",
    "/api/qa/runs/latest",
    "/api/qa/agents?from=2026-08-16&to=2026-08-16",
  ];
  for (const endpoint of directNumberEndpoints) {
    const result = await authenticatedFetch(page, endpoint);
    expect(result.status, endpoint).toBe(200);
    expect(result.contentType, endpoint).toMatch(/application\/json/i);
  }

  for (const endpoint of [
    "/api/qa/download?from=2026-08-16&to=2026-08-16",
    "/api/ob-report/download?from=2026-08-16&to=2026-08-16",
    "/api/ob-analytics/download?from=2026-08-16&to=2026-08-16",
    "/api/live-transfers/download?from=2026-08-16&to=2026-08-16",
  ]) {
    const result = await authenticatedFetch(page, endpoint);
    expect(result.status, endpoint).toBe(200);
    expect(result.zipMagic, endpoint).toBe(true);
    expect(result.byteLength, endpoint).toBeGreaterThan(100);
    expect(result.disposition, endpoint).toMatch(/attachment/i);
  }

  const missing = await authenticatedFetch(page, "/api/phase-1-route-that-does-not-exist");
  expect(missing.status).toBe(404);
  expect(missing.bodyPrefix).toMatch(/not found/i);
  const invalidSheet = await authenticatedFetch(page, "/api/sheet?id=not-approved&gid=0");
  expect(invalidSheet.status).toBe(403);
  expect(invalidSheet.bodyPrefix).not.toMatch(/stack|postgres|password/i);

  const accessBoundaryChecks = [
    ["POST", "/api/attendance/import"],
    ["POST", "/api/readymode/upload"],
    ["POST", "/api/users"],
    ["PATCH", "/api/users/1"],
    ["DELETE", "/api/users/1"],
    ["POST", "/api/team-agents"],
    ["PATCH", "/api/team-agents/1"],
    ["DELETE", "/api/team-agents/1"],
  ] as const;
  for (const [method, endpoint] of accessBoundaryChecks) {
    const response = await request.fetch(`http://127.0.0.1:8080${endpoint}`, { method, data: {} });
    expect(response.status(), `${method} ${endpoint}`).toBe(401);
  }
  const importer = await request.post("http://127.0.0.1:8080/api/ob-report/import", { data: { rows: [] } });
  expect(importer.status()).toBe(403);

  expect(apiRequests).toContain("GET /api/quo/stats");
  expect(apiRequests).toContain("GET /api/vos/stats");
  expect(apiRequests).toContain("GET /api/readymode/stats");
  expect(apiRequests).toContain("GET /api/sheet");
  expect(pageErrors).toEqual([]);
  expect(unexpectedApiFailures).toEqual([
    "404 GET /api/phase-1-route-that-does-not-exist",
    "403 GET /api/sheet",
  ]);

  const revokedSession = await page.evaluate(async () => {
    const token = localStorage.getItem("tracker_token") ?? sessionStorage.getItem("tracker_token") ?? "";
    const logout = await fetch("/api/auth/logout", { method: "POST" });
    const me = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    return { logoutStatus: logout.status, meAfterLogoutStatus: me.status };
  });
  expect(revokedSession).toEqual({ logoutStatus: 200, meAfterLogoutStatus: 401 });
  expect(unexpectedApiFailures.at(-1)).toBe("401 GET /api/auth/me");
});
