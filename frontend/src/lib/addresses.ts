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
} as const;

export const isDeployed = (addr: string): boolean =>
  addr.toLowerCase() !== ZERO && /^0x[0-9a-fA-F]{40}$/.test(addr);

/**
 * SaucerSwap V3 + HTS token addresses on Hedera mainnet. These are
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
