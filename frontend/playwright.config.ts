import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for E2E browser tests.
 *
 * BASE_URL defaults to the live production deploy so tests can run without
 * `npm run dev` running. Override to `http://localhost:3000` for local
 * iteration. Override to a preview URL for branch-deploy testing.
 */
export default defineConfig({
  testDir: "./__tests__/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://www.fissionp.com",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
