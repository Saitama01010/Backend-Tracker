import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env["STAGING_READONLY_BASE_URL"]?.trim();
if (!baseURL) throw new Error("STAGING_READONLY_BASE_URL is required");

export default defineConfig({
  testDir: "./tests/staging-readonly",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
