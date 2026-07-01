/**
 * trade-window — the FEASIBLE-SIZE guard shared by every AMM form.
 *
 * WHY THIS EXISTS
 * ---------------
 * trade-cap.ts / trade-limits.ts only model the UPPER bound of a trade (the
 * maxTradeBps cap + the 1%-of-depth slippage gate). They do NOT model the
 * Pendle-V2 logit-AMM PROPORTION cap, which produces a hard on-chain revert
 * boundary that the UI was completely blind to:
 *
 *   proportion = totalPt / (totalPt + totalAsset)   must stay <= MAX (0.96).
 *
 * A Buy PT (SY->PT) REMOVES PT, so it LOWERS proportion. When the pool is
 * already PT-heavy (proportion at/above the cap, which is TODAY's live state:
 * ~0.9602 vs 0.96) a *small* PT buy doesn't remove enough PT to cross back
 * under 0.96 and reverts `MarketProportionTooHigh` (0xaf53f054). So there is a
 * hard MINIMUM buy size, not just a maximum. The old guard let small buys pass
 * the button then revert on-chain, surfacing as a misleading
 * "Price quoter unreachable" abort AFTER the irreversible HBAR->SY zap.
 *
 * Conversely a Sell PT / Buy YT ADDS PT (raises proportion). While proportion
 * is already >= MAX those sides are ENTIRELY INFEASIBLE (even 1 wei reverts):
 * the pool must first be re-balanced by a PT buy.
 *
 * SIDE MAP (verified against the live curve via mirror-node eth_call binary
 * search, 2026-06/07 — see the feasibility notes in the design brief):
 *   buyPt   SY->PT : removes PT -> lowers proportion. Has a MIN floor.
 *   sellYt  YT->SY : unwinds by removing PT -> shares buyPt's window.
 *   sellPt  PT->SY : adds PT -> raises proportion. Infeasible while >= MAX.
 *   buyYt   SY->YT : mints then sells PT -> raises proportion. Infeasible >= MAX.
 *   addLp          : balanced add; its HBAR path routes a small internal PT
 *                    buy, so it shares buyPt's MIN floor but is otherwise
 *                    bounded by the caller's contract cap.
 *
 * UNITS
 * -----
 * The bounds are returned in the RAW units of the token the user actually
 * types into the form:
 *   buyPt / buyYt / addLp : SY-in raw (the amount removed as PT ~= SY spent;
 *                           PT redeems ~1:1 for SY at exchangeRate=1e18, so
 *                           ptOut ~= syUsed and we can gate on the SY axis).
 *   sellPt                : PT-in raw.
 *   sellYt                : the PT the unwind removes ~= YT-in raw.
 * All of PT/YT/SY are 18-dec on this market, so a single scale applies, but we
 * keep `decimals` explicit so a future non-18-dec market stays correct.
 *
 * EXACTNESS
 * ---------
 * MIN = ceil((totalPt - k*A)) where k = MAX/(1-MAX) and A = totalAsset
 * (= totalSy * syExchangeRate / 1e18). This matched the on-chain revert
 * boundary to the RAW UNIT in the empirical scan (correction factor 1.000000).
 * We add a small +0.1% safety margin so a real buy — which nudges proportion
 * by its own rounding — never lands exactly on the strict '>' cliff.
 *
 * MAX (the MarketExchangeRateBelowOne curve ceiling) needs the fee-rate curve
 * (lnFeeRateRoot / reserveFeePercent) which is NOT carried on MarketDetail, so
 * we do NOT reconstruct it here. Instead each form passes its already-live
 * upper cap (maxPtBuyable / maxYtBuyable / computeSizeLimit.maxAllowed) as
 * `existingMax`; we take the tighter of that and (for the PT-adding sides) the
 * proportion headroom. This keeps the helper pure + synchronous and never
 * over-quotes the max.
 *
 * FAIL-SAFE: if reserves are missing / zero the helper returns a permissive
 * window (min = 0, max = existingMax) with `reason = null` so a transient read
 * gap can NEVER block a legitimate trade — the on-chain guards still backstop.
 */

/** Default Pendle-V2 proportion cap for this market (MAX_MARKET_PROPORTION). */
export const MAX_MARKET_PROPORTION = 0.96;

export type TradeSide = "buyPt" | "sellYt" | "sellPt" | "buyYt" | "addLp";

export interface TradeWindow {
  /**
   * Smallest raw input the AMM will accept. 0n when the pool is already healthy
   * (any dust passes). Never null for the feasible sides.
   */
  minInput: bigint;
  /**
   * Largest raw input (the tighter of the proportion headroom and the caller's
   * existing contract/depth cap). 0n when the side is currently infeasible.
   */
  maxInput: bigint;
  /** True when there is NO feasible size right now (PT-adding side, pool >= MAX). */
  imbalanced: boolean;
  /**
   * Human copy for the range line + the disabled-button reason. null when the
   * pool is healthy and no special message is needed.
   */
  reason: string | null;
}

const ONE = 10n ** 18n;

/** ceil(a / b) for positive-ish bigints. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/**
 * DECIMALS-01 compact render (mirrors trade-limits.formatCompactBigint) so the
 * range numbers match the canonical 18-dec value shown everywhere else.
 */
export function formatWindowAmount(v: bigint, decimals = 18): string {
  if (v <= 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const fracStr = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  // Show up to 6 significant fractional digits; sub-unit dust markets (this one)
  // read as e.g. "0.00000009".
  const frac = fracStr.slice(0, 8);
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

export interface TradeWindowArgs {
  side: TradeSide;
  /** Live pool PT reserve (raw), from detail.totalPt. */
  totalPt: bigint;
  /** Live pool SY reserve (raw), from detail.totalSy. */
  totalSy: bigint;
  /** SY exchangeRate (1e18-scaled), from detail.syExchangeRate. Defaults 1e18. */
  syExchangeRate?: bigint;
  /** Proportion cap. Defaults to MAX_MARKET_PROPORTION. */
  maxProportion?: number;
  /**
   * The caller's already-computed upper cap in the SAME raw units this window
   * returns (maxPtBuyable / maxYtBuyable / computeSizeLimit.maxAllowed). 0n or
   * undefined => "not read yet", treated as no extra cap.
   */
  existingMax?: bigint;
  /** Token decimals for the copy. Defaults 18. */
  decimals?: number;
}

/**
 * Compute the feasible input window for one side at the live reserves.
 * Pure + synchronous — reserves come from the already-live MarketDetail prop.
 */
export function computeTradeWindow(args: TradeWindowArgs): TradeWindow {
  const {
    side,
    totalPt,
    totalSy,
    syExchangeRate = ONE,
    maxProportion = MAX_MARKET_PROPORTION,
    existingMax,
    decimals = 18,
  } = args;

  const cap = existingMax !== undefined && existingMax > 0n ? existingMax : null;

  // FAIL-SAFE: no reserves -> permissive window, never block.
  if (totalPt <= 0n || totalSy <= 0n) {
    return { minInput: 0n, maxInput: cap ?? 0n, imbalanced: false, reason: null };
  }

  // A = totalAsset = totalSy * exchangeRate / 1e18. Do NOT hardcode; syExchangeRate
  // is currently 1e18 but moves with yield accrual.
  const A = (totalSy * (syExchangeRate > 0n ? syExchangeRate : ONE)) / ONE;

  // k = MAX/(1-MAX). At MAX=0.96 this is 24. Scale to bigint via a fixed-point
  // numerator/denominator so we stay exact for non-round caps too.
  //   k = maxProportion / (1 - maxProportion)
  // ptCap = k * A = A * maxProportion / (1 - maxProportion)
  const SCALE = 1_000_000n;
  const maxNum = BigInt(Math.round(maxProportion * 1_000_000)); // e.g. 960000
  const maxDen = SCALE - maxNum; // (1 - MAX) scaled -> 40000
  // ptCap = A * maxNum / maxDen  (== 24*A at 0.96)
  const ptCap = maxDen > 0n ? (A * maxNum) / maxDen : 0n;

  // proportion headroom for PT-REMOVING sides: how much PT must be removed to
  // reach the cap. Positive when pool is over-cap (a MIN floor); <= 0 when
  // healthy (no floor).
  const ptToRemoveToReachCap = totalPt - ptCap; // = totalPt - k*A

  const fmt = (v: bigint) => formatWindowAmount(v, decimals);

  switch (side) {
    case "buyPt":
    case "sellYt":
    case "addLp": {
      // PT-REMOVING: proportion falls. MIN = the PT (~= SY-in) needed to cross
      // under the cap, +0.1% safety so we never sit on the strict '>' boundary.
      let minInput = 0n;
      let reason: string | null = null;
      if (ptToRemoveToReachCap > 0n) {
        minInput = ceilDiv(ptToRemoveToReachCap * 1001n, 1000n); // +0.1%
        reason =
          `Pool is PT-heavy right now — the smallest trade that keeps the ` +
          `AMM balanced is ~${fmt(minInput)}. Enter at least that much.`;
      }
      // MAX = the caller's live contract/depth cap. (The exact curve ceiling
      // needs the fee-rate params we don't carry here; the contract cap is
      // always <= it in practice and backstops on-chain regardless.)
      const maxInput = cap ?? 0n;
      // If the floor exceeds the cap the side is momentarily un-tradeable at any
      // size the periphery allows — surface it honestly rather than a dead range.
      const imbalanced = minInput > 0n && maxInput > 0n && minInput > maxInput;
      if (imbalanced) {
        reason =
          `Pool is imbalanced — the minimum balanced trade (~${fmt(minInput)}) ` +
          `is above the current per-trade cap. Try again shortly.`;
      }
      return { minInput, maxInput, imbalanced, reason };
    }
    case "sellPt":
    case "buyYt": {
      // PT-ADDING: proportion rises. Feasible ONLY while already under the cap,
      // and only up to the headroom that keeps it under the cap.
      const headroom = -ptToRemoveToReachCap; // = k*A - totalPt
      if (headroom <= 0n) {
        return {
          minInput: 0n,
          maxInput: 0n,
          imbalanced: true,
          reason:
            "Pool is PT-saturated — a PT buy is needed to reopen this side. " +
            "Buy PT (or Sell YT) first to rebalance the pool.",
        };
      }
      // proportion headroom max, tightened by the caller's contract cap.
      const propMax = headroom;
      const maxInput = cap !== null && cap < propMax ? cap : propMax;
      return {
        minInput: 0n,
        maxInput,
        imbalanced: false,
        reason: `Max balanced size right now is ~${fmt(maxInput)}.`,
      };
    }
    default:
      return { minInput: 0n, maxInput: cap ?? 0n, imbalanced: false, reason: null };
  }
}

/**
 * True iff `input` (raw) sits inside the feasible window. A 0 input is treated
 * as "nothing to check" (returns true) so the empty-field state uses the
 * form's own "Enter amount" copy, not the range error.
 */
export function isWithinWindow(input: bigint, w: TradeWindow): boolean {
  if (w.imbalanced) return false;
  if (input <= 0n) return true;
  if (w.minInput > 0n && input < w.minInput) return false;
  if (w.maxInput > 0n && input > w.maxInput) return false;
  return true;
}

/**
 * One-line "Enter between X and Y" copy for the input caption. Returns null when
 * there's nothing useful to say (healthy pool, no cap read yet).
 */
export function windowRangeLine(
  w: TradeWindow,
  tokenSym: string,
  decimals = 18,
): string | null {
  if (w.imbalanced) return w.reason;
  const hasMin = w.minInput > 0n;
  const hasMax = w.maxInput > 0n;
  if (!hasMin && !hasMax) return null;
  const lo = hasMin ? formatWindowAmount(w.minInput, decimals) : null;
  const hi = hasMax ? formatWindowAmount(w.maxInput, decimals) : null;
  if (lo && hi) return `Enter between ${lo} and ${hi} ${tokenSym}.`;
  if (lo) return `Enter at least ${lo} ${tokenSym} (pool is PT-heavy).`;
  return `Enter up to ${hi} ${tokenSym}.`;
}
