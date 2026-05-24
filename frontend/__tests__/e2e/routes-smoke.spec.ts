/**
 * Routes smoke — visits every important page with a connected mock EVM
 * wallet and asserts zero React errors.
 *
 * This is the single highest-ROI test: every wallet-modal bug, hooks-order
 * regression, and #300 maximum-update-depth loop manifests as a console
 * error during initial render or state transition. By visiting every
 * route after connect, we catch the bug class that hit production
 * repeatedly during the EVM-picker rollout.
 *
 * Does NOT submit any transactions — purely render-time assertions.
 */

import { test, expect } from "@playwright/test";
import { bootstrapEvm } from "./helpers/connect";

const MARKET_ADDR = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";

const ROUTES = [
  { path: "/", name: "landing" },
  { path: "/markets", name: "markets list" },
  { path: `/markets/${MARKET_ADDR}`, name: "market overview" },
  { path: `/markets/${MARKET_ADDR}/pt`, name: "PT strategy" },
  { path: `/markets/${MARKET_ADDR}/yt`, name: "YT strategy" },
  { path: `/markets/${MARKET_ADDR}/lp`, name: "LP strategy" },
  { path: "/profile", name: "profile" },
];

test.describe("routes smoke — every page renders without React errors", () => {
  for (const route of ROUTES) {
    test(`${route.name} (${route.path})`, async ({ page, context }) => {
      // strictMode = true: only assert on React-fatal patterns. Other
      // console.error messages (e.g., CORS-blocked CoinGecko price feed)
      // are tracked as warnings but won't fail the build.
      const { errors } = await bootstrapEvm(context, page, { strictMode: true });

      await page.goto(route.path);

      // Wait for the page to settle — Next.js may have client-side data
      // fetches in flight. 5 seconds is enough for any of these routes
      // to finish their initial render.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {
        // networkidle can flake on routes that poll. Fall back to a fixed wait.
      });
      await page.waitForTimeout(2_000);

      // Hard assert: any React #300, hooks order violation, or unhandled
      // throw will land in `errors` via the page-error / console-error
      // listeners attached in bootstrapEvm.
      expect(errors, `react/console errors on ${route.path}:\n${errors.join("\n")}`).toEqual([]);
    });
  }
});
