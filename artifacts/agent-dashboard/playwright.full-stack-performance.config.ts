import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/full-stack-performance",
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:4178",
    ...devices["Desktop Chrome"],
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --dir ../api-server exec tsx src/businessContracts/fullStackServer.ts",
      url: "http://127.0.0.1:8080/api/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm exec vite --config vite.config.ts --host 0.0.0.0 --port 4178 --strictPort",
      url: "http://127.0.0.1:4178",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
