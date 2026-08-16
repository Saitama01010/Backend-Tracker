import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const email = process.env["STAGING_READONLY_EMAIL"]?.trim();
const password = process.env["STAGING_READONLY_PASSWORD"];
const from = process.env["STAGING_READONLY_FROM"]?.trim() ?? "2026-07-01";
const to = process.env["STAGING_READONLY_TO"]?.trim() ?? "2026-07-07";
if (!email || !password) throw new Error("STAGING_READONLY_EMAIL and STAGING_READONLY_PASSWORD are required");
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
  throw new Error("STAGING_READONLY_FROM/TO must be an ordered closed YYYY-MM-DD range");
}

async function chooseView(page: Page, label: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Choose dashboard view" }).click();
  await page.getByRole("option", { name: label }).click();
}

test("optional deployment smoke is read-only, source-aware, redacted, and fixed-range", async ({ page }) => {
  const routeStatuses = new Map<string, Set<number>>();
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const key = `${response.request().method()} ${url.pathname}`;
    const statuses = routeStatuses.get(key) ?? new Set<number>();
    statuses.add(response.status());
    routeStatuses.set(key, statuses);
  });

  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.locator("input#tracker-password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Backend Tracker" })).toBeVisible();

  const refreshed = await page.evaluate(async () => {
    const response = await fetch("/api/auth/refresh", { method: "POST" });
    return response.ok && typeof (await response.json() as { token?: unknown }).token === "string";
  });
  expect(refreshed).toBe(true);

  const pageChecks: Record<string, boolean> = {};
  for (const id of ["retention", "cs", "nsf", "rmk"] as const) {
    const tab = page.getByTestId(`tab-${id}`);
    if (await tab.count() === 0) continue;
    await tab.click();
    const panel = page.getByTestId("active-metrics-panel");
    await expect(panel).toHaveAttribute("data-active-tab", id);
    pageChecks[id] = await panel.evaluate((element) => {
      const text = (element.textContent ?? "").replace(/,/g, "");
      return /\b\d+(?:\.\d+)?%?\b/.test(text) && !/temporarily unavailable|failed to load/i.test(text);
    });
  }

  const callbackTab = page.getByTestId("tab-callback-review");
  if (await callbackTab.count()) {
    await callbackTab.click();
    await page.getByLabel("Callback review from date").fill(from);
    await page.getByLabel("Callback review to date").fill(to);
    const retention = page.getByRole("button", { name: "Retention", exact: true });
    if (await retention.count()) await retention.last().click();
    const allTeams = page.getByRole("button", { name: "All Teams", exact: true });
    if (await allTeams.count()) await allTeams.click();
    pageChecks["callback-review"] = true;
  }

  await chooseView(page, /Backend Stats/i);
  await expect(page.getByRole("heading", { name: "Backend Statistics" })).toBeVisible();
  pageChecks["google-sheets"] = await page.getByText("Total Files").isVisible();
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Rows" }).click();
  expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/i);

  await chooseView(page, /Phones/i);
  for (const source of ["Quo Lines", "PBX", "ReadyMode"] as const) {
    const sourceTab = page.getByRole("button", { name: source, exact: true }).first();
    await sourceTab.click();
    pageChecks[source] = await page.locator("main").evaluate((element) => {
      const text = (element.textContent ?? "").replace(/,/g, "");
      return /\b\d+(?:\.\d+)?%?\b/.test(text) && !/temporarily unavailable|failed to load/i.test(text);
    });
  }

  const onboardingTab = page.getByTestId("tab-onboarding");
  if (await onboardingTab.count()) {
    await onboardingTab.click();
    const download = page.getByRole("button", { name: "Download Analysis" });
    if (await download.count()) {
      const xlsxDownload = page.waitForEvent("download");
      await download.click();
      expect((await xlsxDownload).suggestedFilename()).toMatch(/\.xlsx$/i);
    }
  }

  expect(Object.values(pageChecks).every(Boolean)).toBe(true);
  expect([...routeStatuses.values()].flatMap((values) => [...values]).every((status) => status < 400)).toBe(true);

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: /log out|sign out/i }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  const normalized = {
    schemaVersion: 1,
    range: { from, to },
    checks: Object.fromEntries(Object.keys(pageChecks).sort().map((key) => [key, pageChecks[key]])),
    routes: [...routeStatuses].sort(([left], [right]) => left.localeCompare(right)).map(([route, statuses]) => ({ route, statuses: [...statuses].sort() })),
  };
  const output = {
    schemaVersion: 1,
    range: normalized.range,
    allChecksPassed: Object.values(pageChecks).every(Boolean),
    routeCount: normalized.routes.length,
    normalizedSha256: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  };
  const outputDir = path.resolve(import.meta.dirname, "../../../../.artifacts/phase-1-staging-readonly");
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
});
