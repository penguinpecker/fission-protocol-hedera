/**
 * Deployed contract addresses, sourced from build-time env so a deploy can change
 * them without a code change. Addresses default to zero — the UI must guard against
 * "not yet deployed" state and degrade to a "coming soon" message rather than
 * silently 0x0-call.
 */
const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const ADDRESSES = {
  factory: (process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? ZERO) as `0x${string}`,
  // `router` is the production router used by every SY-source flow. After
  // the ActionRouter v3 deploy (2026-05-14) this should point to v3, which
  // fixes the addLiquidityProportional typing bug. Falls back to ZERO so
  // the UI can degrade gracefully if env isn't wired.
  router: (process.env.NEXT_PUBLIC_ROUTER_ADDRESS ?? ZERO) as `0x${string}`,
  fissionZap: (process.env.NEXT_PUBLIC_FISSION_ZAP_ADDRESS ?? ZERO) as `0x${string}`,
  // MegaZap collapses the HBAR-source chain (HBAR → SY → PT/YT/LP) into one
  // signature. Optional — when not deployed in the current env, forms fall
  // back to the legacy multi-step chain via FissionZap + Router.
  megaZap: (process.env.NEXT_PUBLIC_MEGA_ZAP_ADDRESS ?? ZERO) as `0x${string}`,
  // FissionLens — read-only swap-preview contract. Forms call it before
  // showing a quote so minSyOut/minPtOut are computed against the exact
  // Pendle V2 curve output instead of the dApp's simple-interest model.
  // Without the lens, Sell YT in particular needs 5%+ slippage tolerance
  // because the linear model drifts ~1.8% high vs the actual logit curve.
  lens: (process.env.NEXT_PUBLIC_LENS_ADDRESS ?? "0x0000000000000000000000000000000000a00fde") as `0x${string}`,
  // FissionUnzap v1 — 1-tx PT/SY/LP → native HBAR. SUPERSEDED by gateway.
  // Kept for one cycle so any in-flight allowances users granted to it can
  // still be exercised; new code paths should call the gateway instead.
  fissionUnzap: (
    process.env.NEXT_PUBLIC_FISSION_UNZAP_ADDRESS &&
    process.env.NEXT_PUBLIC_FISSION_UNZAP_ADDRESS.length > 2
      ? process.env.NEXT_PUBLIC_FISSION_UNZAP_ADDRESS
      : "0x0000000000000000000000000000000000a01a63"
  ) as `0x${string}`,
  // FissionGateway — v2 unified periphery (2026-05-26 deploy at 0.0.10493916).
  // Replaces MegaZap + FissionUnzap with a single contract:
  //   - takes only market addr per function (resolves PT/YT/LP/SY internally)
  //   - FIXED unzapSy bug (derives shareToken from adapter via shareToken())
  //   - lazy int64.max approvals → 4-9 fewer child records per call
  //   - custom errors with values (SlippageTooHigh, etc.) — no more empty 0x
  //   - sweep + quote + 2-step ownership + rescueToken
  // 7 user actions: zapHbarToPt/Yt/Lp/Sy + sellPtForHbar + sellLpForHbar +
  // unzapSyForHbar (atomic 1-tx each; Buy YT in degenerate pool may fall
  // back to 2-tx chain — frontend handles the routing).
  fissionGateway: (
    process.env.NEXT_PUBLIC_FISSION_GATEWAY_ADDRESS &&
    process.env.NEXT_PUBLIC_FISSION_GATEWAY_ADDRESS.length > 2
      ? process.env.NEXT_PUBLIC_FISSION_GATEWAY_ADDRESS
      : "0x0000000000000000000000000000000000a01fdc"
  ) as `0x${string}`,
} as const;

export const isDeployed = (addr: string): boolean =>
  addr.toLowerCase() !== ZERO && /^0x[0-9a-fA-F]{40}$/.test(addr);

// "Effectively infinite" HTS approval: set once, never re-prompt. Standard
// DeFi pattern — converts the 3-tx LP-add (approve SY → approve PT →
// addLiquidity) into a 1-tx flow after the first interaction. Trust
// assumption (router can pull unbounded amounts) is the same one already
// in place; router_v3 is audited and the only spender we approve.
//
// HTS GOTCHA: Hedera HTS stores allowances as int64, NOT uint256. Passing
// `type(uint256).max` overflows the int64 bound check in the HTS precompile
// and reverts (CONTRACT_REVERT_EXECUTED, ~800k gas consumed). The correct
// "practical infinity" on Hedera is `type(int64).max = 2^63 - 1` ≈ 9.22e18.
// For all decimal regimes in this protocol (SY=6, USDC=6, WHBAR=8, LP=18),
// this is comfortably larger than any real holding.
export const MAX_HTS_APPROVE = (1n << 63n) - 1n;

/**
 * SaucerSwap V2 + HTS token addresses on Hedera mainnet. These are
 * external (not under our control); pinned here so the Mint-SY flow can
 * read USDC + WHBAR balances and route approvals.
 */
export const HEDERA_TOKENS = {
  USDC:  "0x000000000000000000000000000000000006f89a" as `0x${string}`,
  WHBAR: "0x0000000000000000000000000000000000163b5a" as `0x${string}`,
  WHBAR_CONTRACT: "0x0000000000000000000000000000000000163b59" as `0x${string}`,
} as const;

export const USDC_DECIMALS = 6;
export const WHBAR_DECIMALS = 8;
