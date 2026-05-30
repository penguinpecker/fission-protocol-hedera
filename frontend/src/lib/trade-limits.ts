/**
 * Trade-size guardrails for thin AMMs. At low pool depth, a trade larger
 * than a few percent of the pool moves the implied yield enough that the
 * user's slippage tolerance is exceeded and the tx reverts on-chain.
 *
 * We pre-compute the size cap client-side and disable the trade button
 * before it gets that far. Cheaper UX than a revert receipt.
 *
 * The cap is hardcoded at 1% of total pool depth (totalSy + totalPt).
 * As liquidity grows, the cap scales naturally — there's no governance
 * required to "unlock" larger trades. We picked 1% because Pendle's logit
 * AMM produces ≤0.5% slippage at ≤1% trade size for typical implied APYs
 * in the 5-15% range. If a market has unusually steep curves (e.g.,
 * post-expiry-imminent), the cap may be too generous — but the user's
 * slippage tolerance gate catches that case anyway.
 */

/** Percent of pool depth a single trade can spend. */
export const MAX_TRADE_PCT_OF_POOL = 1;

export interface SizeLimit {
  /** Maximum SY-input the user can submit, in raw bigint scale. */
  maxAllowed: bigint;
  /** Sum of pool reserves (totalSy + totalPt) used as the depth measure. */
  poolDepth: bigint;
  /** True iff the user's typed amount exceeds the cap. */
  exceeded: boolean;
  /** Human-readable copy ready for the warning banner. */
  message: string | null;
}

export function computeSizeLimit(
  parsedAmt: bigint,
  totalSy: bigint,
  totalPt: bigint,
): SizeLimit {
  const poolDepth = totalSy + totalPt;
  if (poolDepth === 0n) {
    return {
      maxAllowed: 0n,
      poolDepth: 0n,
      exceeded: parsedAmt > 0n,
      message: parsedAmt > 0n
        ? "Pool has no liquidity yet — trading isn't possible until the market is seeded."
        : null,
    };
  }
  const maxAllowed = (poolDepth * BigInt(MAX_TRADE_PCT_OF_POOL)) / 100n;
  const exceeded = parsedAmt > maxAllowed;
  return {
    maxAllowed,
    poolDepth,
    exceeded,
    message: exceeded
      ? `Trade too large — max ${MAX_TRADE_PCT_OF_POOL}% of pool depth to keep slippage under 0.5%. Try ≤ ${formatBigCompact(maxAllowed)}.`
      : null,
  };
}

// Local compact formatter mirrors useMarkets.formatCompact (avoids a circular
// import — that module imports wagmi which we don't need here). Exported as
// `formatCompactBigint` so forms can render cap numbers without pulling in the
// wagmi-laden useMarkets module.
export function formatCompactBigint(v: bigint): string {
  return formatBigCompact(v);
}

// DECIMALS-01: mirror useMarkets.formatCompact — render the canonical 18-decimal
// value (raw / 1e18) so cap numbers match wallets, not the raw base-unit count.
function formatBigCompact(v: bigint): string {
  if (v === 0n) return "0";
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const sign = neg ? "-" : "";
  const ONE = 10n ** 18n;

  if (abs >= 1000n * ONE) {
    const whole = abs / ONE;
    const TIERS: ReadonlyArray<{ t: bigint; d: bigint; s: string }> = [
      { t: 1_000_000_000_000n, d: 1_000_000_000_000n, s: "T" },
      { t: 1_000_000_000n,     d: 1_000_000_000n,     s: "B" },
      { t: 1_000_000n,         d: 1_000_000n,         s: "M" },
      { t: 1_000n,             d: 1_000n,             s: "K" },
    ];
    for (const { t, d, s } of TIERS) {
      if (whole >= t) {
        const w = whole / d;
        const frac = ((whole % d) * 100n) / d;
        return frac > 0n ? `${sign}${w}.${frac.toString().padStart(2, "0")}${s}` : `${sign}${w}${s}`;
      }
    }
  }

  const whole = abs / ONE;
  const fracStr = (abs % ONE).toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}
