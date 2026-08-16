import { expect, test } from "@playwright/test";

const ITERATIONS = 12;

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]!;
}

function summary(values: readonly number[]) {
  return {
    iterations: values.length,
    p50Ms: Math.round(percentile(values, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(values, 0.95) * 100) / 100,
    minMs: Math.round(Math.min(...values) * 100) / 100,
    maxMs: Math.round(Math.max(...values) * 100) / 100,
  };
}

test("informational full-stack browser data-visible, large-table render, and request-count baseline", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("phase-one-admin@example.test");
  await page.locator("input#tracker-password").fill("Phase1-Only!2026");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Backend Tracker" })).toBeVisible();

  const dataVisibleMs: number[] = [];
  const largeTableRenderMs: number[] = [];
  const apiRequestCounts: number[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    let requestCount = 0;
    const countRequest = (request: { url(): string }) => { if (request.url().includes("/api/")) requestCount++; };
    page.on("request", countRequest);
    const startedAt = performance.now();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Backend Tracker" })).toBeVisible();
    await page.getByTestId("tab-retention").click();
    const panel = page.getByTestId("active-metrics-panel");
    await expect.poll(async () => /\b[1-9]\d*\b/.test((await panel.innerText()).replace(/,/g, ""))).toBe(true);
    dataVisibleMs.push(performance.now() - startedAt);

    const tableStartedAt = performance.now();
    await page.getByRole("button", { name: "Choose dashboard view" }).click();
    await page.getByRole("option", { name: /Backend Stats/i }).click();
    await expect(page.getByRole("heading", { name: "Backend Statistics" })).toBeVisible();
    await expect(page.getByText("Total Files")).toBeVisible();
    largeTableRenderMs.push(performance.now() - tableStartedAt);
    apiRequestCounts.push(requestCount);
    page.off("request", countRequest);
  }

  console.log(`PHASE1_BROWSER_PERFORMANCE_INFORMATIONAL ${JSON.stringify({
    dataset: { googleSheetRows: 250, postgresPhoneCalls: 5, sourceMode: "sanitized provider fixtures with real frontend, Express, and PostgreSQL" },
    fullStackBrowserDataVisible: summary(dataVisibleMs),
    largeTableRender: summary(largeTableRenderMs),
    browserApiRequestCount: {
      iterations: apiRequestCounts.length,
      p50: percentile(apiRequestCounts, 0.5),
      p95: percentile(apiRequestCounts, 0.95),
      min: Math.min(...apiRequestCounts),
      max: Math.max(...apiRequestCounts),
    },
    enforcement: "informational local/scheduled command; not a normal-CI timing gate",
  })}`);
});
