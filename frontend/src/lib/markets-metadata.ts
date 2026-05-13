/**
 * Hard-coded display metadata for v1 markets. The on-chain factory only
 * stores wiring (SY, PT, YT, LP addresses, expiry, scalarRoot) — it doesn't
 * carry the human-readable name, asset breakdown, or pool source. Until the
 * indexer is taught to derive these from the SY name + chain reads, we keep
 * the per-market display strings here, keyed by the market contract address.
 *
 * Adding a new market = appending one entry. Unknown markets fall back to
 * the SY share-token name and a generic "Yield SY" chip.
 */

export interface MarketDisplay {
  /** Full human label shown in headings. */
  displayName: string;
  /** Short label for chips / breadcrumbs. */
  shortName: string;
  /** Underlying assets the SY wraps, in display order. */
  assets: string[];
  /** Where the yield comes from (the source of the rewards). */
  protocol: string;
  /** Optional pool fee tier in percent (e.g. 0.15 for 15bps). */
  poolFeePct?: number;
  /** One-line "what you're earning" copy. */
  yieldSource: string;
  /** External link to the underlying yield source (pool, validator, etc.). */
  protocolLink?: string;
}

const REGISTRY: Record<string, MarketDisplay> = {
  // Market 0 — SaucerSwap V2 USDC/WHBAR LP (chain 295)
  "0x00000000000000000000000000000000009fadcb": {
    displayName: "USDC / WHBAR LP",
    shortName: "USDC/WHBAR",
    assets: ["USDC", "WHBAR"],
    protocol: "SaucerSwap V3",
    poolFeePct: 0.15,
    yieldSource: "0.15% pool fees from USDC↔WHBAR swaps",
    protocolLink: "https://www.saucerswap.finance/pools",
  },
};

export function getMarketDisplay(address: string): MarketDisplay | null {
  return REGISTRY[address.toLowerCase()] ?? null;
}
