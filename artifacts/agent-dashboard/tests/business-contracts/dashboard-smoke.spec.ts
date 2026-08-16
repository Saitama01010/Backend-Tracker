import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const golden = JSON.parse(await readFile(
  path.join(repoRoot, "artifacts", "api-server", "src", "businessContracts", "fixtures", "goldens", "major-dashboard-responses.json"),
  "utf8",
)) as Record<string, any>;
const inventory = JSON.parse(await readFile(
  path.join(repoRoot, "docs", "refactor", "phase-1-current-behavior-map.json"),
  "utf8",
)) as { dashboardPages: Array<{ id: string }> };

const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function sheetFor(url: URL) {
  const gid = url.searchParams.get("gid");
  const currentRows: string[][] = gid === "1018337469"
    ? [["8/16/2026 10:40:00", "Agent Alpha", "FILE-SHEET-2", "Retained", "", "cancelled text still belongs to retained tab"]]
    : gid === "871007220"
      ? [["8/16/2026 10:10:00", "Agent Alpha", "FILE-IDP", "IDP", "IDP", "handled"]]
      : [
          ["8/16/2026 10:00:00", "Agent Alpha", "FILE-RET", "Retained", "Retained", ""],
          ["8/16/2026 10:20:00", "Agent Beta", "FILE-NSF", "Fixed", "", ""],
          ["8/16/2026 10:30:00", "Agent Gamma", "FILE-CS", "Fixed", "", ""],
          ["8/16/2026 10:35:00", "Agent Delta", "FILE-RMK", "Fixed", "", ""],
        ];
  return {
    ...golden.sheet,
    rows: currentRows,
    meta: { ...golden.sheet.meta, rowsReceived: currentRows.length, rowsAccepted: currentRows.length },
  };
}

async function installApiFixtures(page: Page, failedApi: string[]) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname.endsWith("/download")) {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": "attachment; filename=sanitized.xlsx",
        },
        body: xlsx,
      });
      return;
    }

    if (pathname === "/api/auth/login" || pathname === "/api/auth/me" || pathname === "/api/auth/refresh") return json(route, golden.auth);
    if (pathname === "/api/auth/logout") return json(route, { ok: true });
    if (pathname === "/api/team-agents") return json(route, golden.teamAgents);
    if (pathname === "/api/sheet") return json(route, sheetFor(url));
    if (pathname === "/api/quo/stats") return json(route, golden.quoStats);
    if (pathname === "/api/quo/calls") return json(route, golden.quoCalls);
    if (pathname === "/api/quo/live") return json(route, golden.quoLive);
    if (pathname === "/api/quo/live/refresh") return json(route, { ok: true });
    if (pathname === "/api/quo/all-lines" || pathname === "/api/quo/lines") return json(route, { data: golden.quoLines });
    if (pathname === "/api/quo/line-stats") return json(route, golden.quoLineStats);
    if (pathname === "/api/quo/sync" || pathname === "/api/quo/sync-state") return json(route, { success: true, isSyncing: false });
    if (pathname === "/api/readymode/stats") return json(route, golden.readyModeStats);
    if (pathname === "/api/readymode/probe") return json(route, { status: 200, isJson: false, bodyLength: 512 });
    if (pathname.startsWith("/api/readymode/")) return json(route, { ok: true, rowsStored: 4, days: 2 });
    if (pathname === "/api/vos/stats") return json(route, golden.vosStats);
    if (pathname === "/api/vos/live") return json(route, golden.vosLive);
    if (pathname === "/api/vos/missed-no-callback") return json(route, golden.missedNoCallback);
    if (pathname === "/api/vos/missed-daily") return json(route, golden.missedDaily);
    if (pathname === "/api/vos/missed-hourly") return json(route, golden.missedHourly);
    if (pathname === "/api/vos/missed-breakdown") return json(route, golden.missedBreakdown);
    if (pathname === "/api/vos/callback-review") return json(route, golden.callbackReview);
    if (pathname === "/api/vos/refresh") return json(route, { ok: true });
    if (pathname === "/api/attendance") return json(route, golden.attendance);
    if (pathname.startsWith("/api/attendance/")) return json(route, { ok: true, imported: 2, marked: 2 });
    if (pathname === "/api/violations" && method === "GET") return json(route, golden.violations);
    if (pathname === "/api/violations/verified") return json(route, golden.verifiedViolations);
    if (pathname === "/api/violations/verify") return json(route, { ok: true });
    if (pathname === "/api/qa/stats") return json(route, golden.qaStats);
    if (pathname === "/api/qa/reviews") return json(route, golden.qaReviews);
    if (/^\/api\/qa\/reviews\//.test(pathname)) return json(route, golden.qaReviews.reviews[0]);
    if (pathname === "/api/qa/tasks") return json(route, golden.qaTasks);
    if (pathname === "/api/qa/runs/latest") return json(route, golden.qaLatestRun);
    if (pathname === "/api/qa/process") return json(route, { runId: 2, evaluated: [{ agent: "Agent Alpha", callId: "qa-001" }], skipped: [], errors: [] });
    if (/^\/api\/qa\/tasks\//.test(pathname)) return json(route, { ok: true });
    if (pathname === "/api/ob-report/status") return json(route, golden.onboardingStatus);
    if (pathname === "/api/ob-report/refresh") return json(route, { started: true });
    if (pathname === "/api/ob-analytics") return json(route, golden.onboardingAnalytics);
    if (pathname === "/api/live-transfers/status") return json(route, golden.liveTransfersStatus);
    if (pathname === "/api/live-transfers/refresh") return json(route, { started: true });
    if (pathname === "/api/users") return json(route, golden.users);
    if (/^\/api\/users\//.test(pathname)) return json(route, { ok: true });
    if (pathname === "/api/blocked-numbers") return json(route, method === "GET" ? golden.blockedNumbers : { ok: true });
    if (pathname.startsWith("/api/blocked-numbers/")) return json(route, { ok: true });
    if (pathname === "/api/nsf/readymode-queue") return json(route, golden.nsfQueue);
    if (pathname.startsWith("/api/nsf/readymode-queue/")) return json(route, { ok: true });
    if (pathname === "/api/samia/users") return json(route, golden.samiaUsers);
    if (pathname === "/api/samia/history" || pathname.startsWith("/api/samia/history/")) return json(route, golden.samiaHistory);
    if (pathname === "/api/samia/chat") return json(route, { reply: "Sanitized Samia response", mutations: [] });
    if (pathname === "/api/healthz") return json(route, { status: "ok" });

    failedApi.push(`${method} ${pathname}`);
    await json(route, { error: "unmocked Phase 1 browser endpoint" }, 599);
  });
}

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Email").fill("phase-one@example.test");
  await page.locator("input#tracker-password").fill("sanitized-password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Backend Tracker" })).toBeVisible();
}

async function chooseView(page: Page, label: string) {
  await page.getByRole("button", { name: "Choose dashboard view" }).click();
  await page.getByRole("option", { name: new RegExp(label, "i") }).click();
}

async function assertPopulatedPanel(page: Page, id: string) {
  const panel = page.getByTestId("active-metrics-panel");
  await expect(panel).toHaveAttribute("data-active-tab", id);
  await expect.poll(async () => panel.evaluate((element) => {
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    return text.length >= 30 && /\b[1-9]\d*(?:\.\d+)?\b/.test(text);
  })).toBe(true);
  await expect(panel.getByText(/temporarily unavailable|failed to load/i)).toHaveCount(0);
}

test("every accessible dashboard page renders populated fixture data, filters, refresh, subtabs, and exports", async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedApi: string[] = [];
  const visited = new Set<string>(["login"]);
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) failedApi.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  // The fixture verifies repository behavior, not Google Fonts availability.
  // Keep its console-error gate deterministic and use the app's local fallback
  // fonts instead of contacting the third-party stylesheet during the test.
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await installApiFixtures(page, failedApi);
  await login(page);

  const metricPages = ["retention", "cs", "nsf", "rmk", "missed-no-cb", "callback-review", "violations", "qa", "onboarding"];
  for (const id of metricPages) {
    await test.step(`metrics page ${id}`, async () => {
      await page.getByTestId(`tab-${id}`).click();
      await assertPopulatedPanel(page, id);
      visited.add(id);

      const today = page.getByTestId("active-metrics-panel").getByTestId("button-today");
      if (await today.count()) await today.first().click();
      const refresh = page.getByTestId("active-metrics-panel").getByTestId("button-refresh");
      if (await refresh.count()) await refresh.first().click();

      if (["retention", "cs", "nsf", "rmk"].includes(id)) {
        const panel = page.getByTestId("active-metrics-panel");
        for (const name of ["By call", "By files", "By day"]) {
          const tab = panel.getByRole("tab", { name, exact: true });
          if (await tab.count()) {
            await tab.first().click();
            await expect(tab.first()).toHaveAttribute("data-state", "active");
          }
        }
      }
    });
  }

  await page.getByTestId("tab-retention").click();
  await page.getByTestId("active-metrics-panel").getByRole("tab", { name: "By files", exact: true }).click();
  const csvDownload = page.waitForEvent("download");
  await page.getByTestId("active-metrics-panel").getByTestId("button-export-csv").click();
  await expect((await csvDownload).suggestedFilename()).toMatch(/^files_.*\.csv$/);

  await page.getByTestId("tab-qa").click();
  await assertPopulatedPanel(page, "qa");
  const qaDownload = page.waitForEvent("download");
  await page.getByTestId("active-metrics-panel").getByRole("button", { name: "Export Excel" }).click();
  await expect((await qaDownload).suggestedFilename()).toMatch(/^QA_Reviews_.*\.xlsx$/);

  await page.getByTestId("tab-onboarding").click();
  await assertPopulatedPanel(page, "onboarding");
  const reportDownload = page.waitForEvent("download");
  await page.getByTestId("active-metrics-panel").getByRole("button", { name: "Download Excel" }).click();
  await expect((await reportDownload).suggestedFilename()).toMatch(/^Onboarding_Line_Report_.*\.xlsx$/);
  const analysisDownload = page.waitForEvent("download");
  await page.getByTestId("active-metrics-panel").getByRole("button", { name: "Download Analysis" }).click();
  await expect((await analysisDownload).suggestedFilename()).toMatch(/^Onboarding_Team_Analysis_.*\.xlsx$/);

  await test.step("Backend Statistics", async () => {
    await chooseView(page, "Backend Stats");
    await expect(page.getByRole("heading", { name: "Backend Statistics" })).toBeVisible();
    await expect(page.getByText("Total Files")).toBeVisible();
    const exportDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export Rows" }).click();
    await expect((await exportDownload).suggestedFilename()).toMatch(/^backend_submissions_.*\.csv$/);
    visited.add("backend-stats");
  });

  await test.step("Phones and all phone subtabs", async () => {
    await chooseView(page, "Phones");
    for (const [tab, id] of [["Quo Lines", "phones-quo-lines"], ["PBX", "phones-pbx"], ["ReadyMode", "phones-readymode"]] as const) {
      await page.getByRole("button", { name: tab, exact: true }).first().click();
      await expect(page.getByText(tab, { exact: true }).first()).toBeVisible();
      await expect.poll(async () => /\b[1-9]\d*\b/.test((await page.locator("main").innerText()).replace(/,/g, ""))).toBe(true);
      visited.add(id);
    }
  });

  await test.step("Attendance", async () => {
    await chooseView(page, "Attendance");
    await expect(page.getByRole("heading", { name: "Attendance" })).toBeVisible();
    await expect(page.getByText("Agent Alpha").first()).toBeVisible();
    visited.add("attendance");
  });

  for (const [menuLabel, heading, id] of [
    ["Manage users", "User Management", "admin-users"],
    ["Manage agents", "Agent Roster", "admin-agents"],
    ["Blocked numbers", "Blocked Numbers", "admin-blocked-numbers"],
  ] as const) {
    await test.step(menuLabel, async () => {
      await page.reload();
      await expect(page.getByRole("heading", { name: "Backend Tracker" })).toBeVisible();
      await page.getByRole("button", { name: "Open account menu" }).click();
      await page.getByRole("menuitem", { name: menuLabel }).click();
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      visited.add(id);
    });
  }

  await test.step("Samia opens without sending a model request", async () => {
    await page.reload();
    await page.getByRole("button", { name: "Open Samia" }).click();
    await expect(page.getByText("Samia", { exact: true }).first()).toBeVisible();
    visited.add("samia");
  });

  expect([...visited].sort()).toEqual(inventory.dashboardPages.map((pageEntry) => pageEntry.id).sort());
  expect(failedApi).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expect(page.locator(".vite-error-overlay, #webpack-dev-server-client-overlay")).toHaveCount(0);
  await expect.poll(async () => (await page.locator("body").innerText()).trim().length > 0).toBe(true);
});
