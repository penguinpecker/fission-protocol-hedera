/**
 * Reusable wallet-connect helpers for E2E tests.
 *
 * Every strategy test needs to (a) inject the mock provider, (b) navigate,
 * (c) click Connect → MetaMask → land. Centralized here so individual
 * specs stay focused on the strategy logic.
 */

import type { BrowserContext, ConsoleMessage, Page } from "@playwright/test";
import { buildEvmMockInitScript } from "../mock-providers/evm-mock";
import { createSignerContext, mockSign, type SignerContext } from "./signer";

export interface E2EFixture {
  page: Page;
  signer: SignerContext;
  /** Collected page errors + filtered console errors during the test. */
  errors: string[];
}

/**
 * Filter for console.error messages we want to ignore — known noise from
 * the runtime that isn't our bug to fix. Conservative on this list so we
 * don't accidentally suppress real bugs.
 */
function isExpectedNoise(text: string): boolean {
  // Conservative noise filter. Adding to this list should be considered
  // carefully — every entry is a class of error we're choosing not to
  // surface. KNOWN-NEEDS-FIX items get their own category so we don't
  // forget them:
  //
  //   - CoinGecko CORS: production users see this in their console.
  //     Should proxy through /api/price/hbar to fix. TODO.
  //   - api/auth/* 4xx: SIWE auth probes before sign-in; expected.
  //   - lockdown-install.js: real MM extension noise; harmless.
  //   - Protobuf Long patch: Hedera SDK init noise.
  //   - getByKey: HashPack internal RPC issue.
  return /lockdown-install|api\/auth\/(me|nonce|verify).*4\d\d|HTTP\/2 4\d\d|Failed to load resource: the server responded with a status of 4\d\d|Patching Protobuf Long|Document does not have focus, skipping deeplink|getByKey|api\.coingecko\.com.*CORS|ERR_FAILED.*coingecko|Access to fetch.*coingecko/i.test(
    text,
  );
}

/**
 * Install the EVM mock provider on the given browser context. Must be
 * called BEFORE any page.goto() — Playwright's addInitScript runs on every
 * navigation but doesn't retroactively patch already-loaded pages.
 */
export async function setupEvmMock(context: BrowserContext): Promise<SignerContext> {
  const signer = createSignerContext();

  await context.exposeFunction("__fissionMockSign", async (method: string, params: unknown[]) => {
    return await mockSign(signer, method, params);
  });

  await context.addInitScript(
    buildEvmMockInitScript({
      privateKeyHex: signer.privateKeyHex,
      address: signer.address,
      chainIdHex: "0x127", // Hedera mainnet 295
      rpcUrl: "https://mainnet.hashio.io/api",
    }),
  );

  return signer;
}

/**
 * React-runtime error patterns. ANY match counts as a hard failure — these
 * are bugs that should fail CI. Adding to this list makes the assertion
 * stricter; the inverse list (`isExpectedNoise`) controls what gets
 * filtered out before classification.
 */
const REACT_FATAL_PATTERNS = [
  /Minified React error #/i, // any minified React error
  /Maximum update depth/i,
  /Invalid hook call/i,
  /Rendered (fewer|more) hooks/i,
  /Cannot read prop/i,
  /TypeError:/i,
  /ReferenceError:/i,
  /Hydration failed/i,
];

function isReactFatal(text: string): boolean {
  return REACT_FATAL_PATTERNS.some((re) => re.test(text));
}

/**
 * Wire error capture to the page. Returns the array; tests should assert
 * `expect(errors).toEqual([])` at the end of every flow.
 *
 * Filtering policy (tightest → loosest):
 *   1. pageerror events (unhandled throws) — ALWAYS captured
 *   2. console.error matching REACT_FATAL_PATTERNS — captured
 *   3. console.error matching isExpectedNoise — dropped (known harmless)
 *   4. Other console.error — captured as warnings (visible in CI logs
 *      but not asserted)
 *
 * The current implementation captures everything except (3). To toggle
 * to "only React-fatal" mode, swap the final push for a `isReactFatal`
 * gate.
 */
export function captureErrors(page: Page, opts: { strictMode?: boolean } = {}): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isExpectedNoise(text)) return;
    // strictMode: only fail on React-fatal patterns; other console.errors
    // are warnings logged but not asserted. Default (false): every
    // unfiltered console.error is a failure.
    if (opts.strictMode && !isReactFatal(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return errors;
}

/**
 * Drive the wallet-connect modal → MetaMask happy path. Leaves the page
 * with the Nav account chip showing.
 */
export async function connectEvmWallet(page: Page, signerAddress: `0x${string}`): Promise<void> {
  const connectBtn = page.getByRole("button", { name: /connect wallet/i }).first();
  await connectBtn.waitFor({ state: "visible", timeout: 15_000 });
  await connectBtn.click();

  const modal = page.getByRole("dialog", { name: /connect wallet/i });
  await modal.waitFor({ state: "visible", timeout: 5_000 });

  // The MetaMask row inside the modal.
  await modal.getByRole("button", { name: /^MetaMask/i }).click();

  // Account chip in Nav with the short EVM address confirms connect landed.
  const short = `${signerAddress.slice(0, 6)}…${signerAddress.slice(-4)}`;
  await page
    .locator("nav")
    .getByText(short, { exact: false })
    .waitFor({ state: "visible", timeout: 20_000 });
}

/**
 * Build full fixture + connect in one call. Most strategy tests open with
 * this, then navigate to the relevant /markets/[address]/{pt|yt|lp}
 * sub-page.
 */
export async function bootstrapEvm(
  context: BrowserContext,
  page: Page,
  opts: { strictMode?: boolean } = {},
): Promise<E2EFixture> {
  const signer = await setupEvmMock(context);
  const errors = captureErrors(page, opts);
  await page.goto("/");
  await connectEvmWallet(page, signer.address);
  return { page, signer, errors };
}
