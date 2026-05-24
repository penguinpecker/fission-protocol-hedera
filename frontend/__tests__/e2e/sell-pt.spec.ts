/**
 * Sell PT — connect → navigate to PT page → toggle Sell → enter tiny
 * raw amount → click action → assert tx hash appears.
 *
 * Submits a REAL transaction via the mock provider (signs with operator
 * key, forwards to Hashio). Uses microscopic amounts (50,000 raw PT ≈
 * negligible $) so the gas cost per test is bounded.
 *
 * This is the canonical pattern for strategy tests:
 *   1. bootstrapEvm() — inject mock + connect
 *   2. page.goto() the strategy page
 *   3. Switch tab if needed (e.g., Buy/Sell)
 *   4. Type amount, click action
 *   5. Wait for the success state (data-testid="sell-pt-success")
 *   6. Assert React-fatal errors == []
 */

import { test, expect } from "@playwright/test";
import { bootstrapEvm } from "./helpers/connect";

const MARKET = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";

// 50,000 raw PT ≈ $0.003. Operator has 7.3B PT so this is dust to them
// and well below any AMM minimum-output thresholds.
const SELL_AMOUNT_RAW = "50000";

// TEMPLATE — disabled by default until validated against a preview deploy.
// To enable: set RUN_STRATEGY_TESTS=1 and point E2E_BASE_URL at a build
// that contains the new data-testid attributes (this branch's preview, or
// production after this branch is merged). Then iterate on selectors /
// waits / amounts. See e2e/README.md "Strategy transactions" section.
const SHOULD_RUN = !!process.env.RUN_STRATEGY_TESTS;

test.describe("Sell PT — EVM mock end-to-end", () => {
  test.skip(!SHOULD_RUN, "Strategy tests disabled — set RUN_STRATEGY_TESTS=1 and point E2E_BASE_URL at this branch's preview to enable");
  test("submits a real swapExactPtForSy and shows success state", async ({ page, context }) => {
    const { errors } = await bootstrapEvm(context, page);

    await page.goto(`/markets/${MARKET}/pt`);

    // Wait for the strategy page to fully hydrate. WalletGate gates the
    // children on `adapter.isConnected && chainId === 295` — first render
    // can race the connector hydration. Look for the page header.
    await page
      .getByRole("heading", { name: /PT/i })
      .waitFor({ state: "visible", timeout: 20_000 });

    // Switch to the Sell tab.
    await page.getByRole("button", { name: /^Sell PT$/ }).click();

    // Force raw mode (the form has a USD/Raw toggle). Click "Raw" if it
    // exists, otherwise type into the USD input — both go through MoneyInput.
    const rawToggle = page.getByRole("button", { name: /^Raw$/ });
    if (await rawToggle.isVisible().catch(() => false)) {
      await rawToggle.click();
    }

    const rawInput = page.getByTestId("money-input-raw");
    await rawInput.waitFor({ state: "visible", timeout: 10_000 });
    await rawInput.fill(SELL_AMOUNT_RAW);

    // Action button. Wait until it's enabled (form is parsing input + checking
    // PT balance + allowance, can take a few seconds on first connect).
    const action = page.getByTestId("sell-pt-action");
    await expect(action).toBeEnabled({ timeout: 20_000 });
    await action.click();

    // Approve might come first (if no allowance), then the swap. The success
    // state surfaces a data-testid="sell-pt-success" element on done.
    // Allow plenty of time: each Hashio tx is 5-10s consensus.
    const success = page.getByTestId("sell-pt-success");
    await expect(success).toBeVisible({ timeout: 90_000 });

    expect(errors, `unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
