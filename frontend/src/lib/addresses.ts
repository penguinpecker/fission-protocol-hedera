/**
 * Deployed contract addresses for the clean-slate rebuild (2026-05-27+).
 * Sourced from env so a deploy can change them without code edits.
 *
 * Post-deploy, set these in Vercel:
 *   NEXT_PUBLIC_FACTORY_ADDRESS
 *   NEXT_PUBLIC_PERIPHERY_ADDRESS
 *   NEXT_PUBLIC_LENS_ADDRESS
 *   NEXT_PUBLIC_SY_ADDRESS
 *
 * Old addresses (Gateway v2/v2.1, MegaZap, FissionUnzap, ActionRouter) are
 * deprecated and not referenced. Only the new Periphery is the user-facing
 * contract from this build onward.
 */
const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const ADDRESSES = {
  factory: (process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? ZERO) as `0x${string}`,

  /**
   * FissionPeriphery — single user-facing contract for ALL Buy/Sell flows.
   * Deterministic 2-tx UX: Tx1 (HBAR↔SY) + Tx2 (SY↔curve). No atomic 1-tx,
   * no fallback paths.
   *
   * Functions (8 user-callable):
   *   zapHbarToSy, buySyForPt, buySyForYt, buySyForLp,
   *   sellPtForSy, sellYtForSy, sellLpForSy, unzapSyToHbar
   */
  periphery: (process.env.NEXT_PUBLIC_PERIPHERY_ADDRESS ?? ZERO) as `0x${string}`,

  /**
   * FissionLens — read-only on-chain swap quoter. Frontend calls it to compute
   * exact minPtOut/minSyOut against the live Pendle V2 curve (eliminates the
   * ~1.8% drift the simple-interest model showed).
   */
  lens: (process.env.NEXT_PUBLIC_LENS_ADDRESS ?? ZERO) as `0x${string}`,

  /**
   * SaucerSwapLPYieldSource — the SY adapter for the live market.
   * Frontend uses this for unzapSyToHbar and for displaying SY balances.
   */
  syAdapter: (process.env.NEXT_PUBLIC_SY_ADDRESS ?? ZERO) as `0x${string}`,

  /**
   * Live market address (single market this build). Frontend uses for
   * forms that need the market addr but only have sy on hand.
   */
  market: (process.env.NEXT_PUBLIC_MARKET_ADDRESS ?? ZERO) as `0x${string}`,

  // ── DEPRECATED (kept for transitional UI references during cutover) ──
  // These all default to ZERO so forms still referencing them via the old
  // adapter ops will see "not deployed" and degrade gracefully. After all
  // forms migrate to `periphery`, remove these entries.
  router: ZERO as `0x${string}`,
  fissionZap: ZERO as `0x${string}`,
  megaZap: ZERO as `0x${string}`,
  fissionUnzap: ZERO as `0x${string}`,
  fissionGateway: ZERO as `0x${string}`,
} as const;

export const isDeployed = (addr: string): boolean =>
  addr.toLowerCase() !== ZERO && /^0x[0-9a-fA-F]{40}$/.test(addr);

/**
 * HTS allowance ceiling — int64.max. Passing uint256.max reverts on the HTS
 * precompile because allowances are stored as int64. For PT/YT/LP/SY at any
 * decimal regime this is comfortably larger than real holdings.
 */
export const MAX_HTS_APPROVE = (1n << 63n) - 1n;

/**
 * SaucerSwap V2 + HTS token addresses on Hedera mainnet. External, pinned.
 */
export const HEDERA_TOKENS = {
  USDC:  "0x000000000000000000000000000000000006f89a" as `0x${string}`,
  WHBAR: "0x0000000000000000000000000000000000163b5a" as `0x${string}`,
  WHBAR_CONTRACT: "0x0000000000000000000000000000000000163b59" as `0x${string}`,
} as const;

export const USDC_DECIMALS = 6;
export const WHBAR_DECIMALS = 8;
