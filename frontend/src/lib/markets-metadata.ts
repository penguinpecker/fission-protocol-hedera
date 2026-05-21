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
  // Market — SaucerSwap V2 USDC/WHBAR LP, 90-day term, expires 2026-08-19.
  // Ed25519-fixed redeploy 2026-05-22 (replaces the legacy 0xfa90…8a6d market
  // which is archived in markets_cache and no longer surfaced).
  "0x36ed8f34c9bfc0004f107153b1a16099f8910b58": {
    displayName: "SaucerSwap USDC/WHBAR · 90D",
    shortName: "SaucerSwap USDC/WHBAR",
    assets: ["USDC", "WHBAR"],
    protocol: "SaucerSwap V2",
    poolFeePct: 0.15,
    yieldSource: "0.15% pool fees from USDC↔WHBAR swaps",
    protocolLink: "https://www.saucerswap.finance/pools",
  },
  // Legacy market (kept for deep-link compatibility — `/markets/[address]/...`
  // pages still resolve display strings via this map even though the market
  // is archived in markets_cache and absent from the /markets list view).
  "0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d": {
    displayName: "SaucerSwap USDC/WHBAR · 90D (archived)",
    shortName: "SaucerSwap USDC/WHBAR (archived)",
    assets: ["USDC", "WHBAR"],
    protocol: "SaucerSwap V2",
    poolFeePct: 0.15,
    yieldSource: "0.15% pool fees from USDC↔WHBAR swaps",
    protocolLink: "https://www.saucerswap.finance/pools",
  },
};

export function getMarketDisplay(address: string): MarketDisplay | null {
  return REGISTRY[address.toLowerCase()] ?? null;
}

/**
 * Tailwind-class color hints for asset chips on the markets list. Subtle tones
 * tuned against the dark background — they read as "tinted" rather than loud
 * brand colors, so multiple assets in one row don't fight each other.
 */
export interface AssetColor {
  /** Background + ring + text tailwind utility classes for a small chip. */
  chip: string;
  /** Hex value for SVG accents (sparklines, bars) that can't take classes. */
  hex: string;
}

const ASSET_COLORS: Record<string, AssetColor> = {
  USDC:  { chip: "border-sky-400/30 bg-sky-400/[0.08] text-sky-200",     hex: "#7dd3fc" },
  WHBAR: { chip: "border-violet-400/30 bg-violet-400/[0.08] text-violet-200", hex: "#c4b5fd" },
  HBAR:  { chip: "border-violet-400/30 bg-violet-400/[0.08] text-violet-200", hex: "#c4b5fd" },
  HBARX: { chip: "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-200", hex: "#86efac" },
};

export function getAssetColor(asset: string): AssetColor {
  return (
    ASSET_COLORS[asset.toUpperCase()] ?? {
      chip: "border-border bg-white/[0.04] text-textSec",
      hex: "#a1a1aa",
    }
  );
}
