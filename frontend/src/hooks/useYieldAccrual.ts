"use client";

/**
 * useYieldAccrual — live 1Hz yield ticker for YT positions.
 *
 * v1 derives a per-second yield rate from the *implied* APY rather than from a
 * real V3-fee oracle. This is intentionally vibes-grade: it lets the position
 * card feel alive (the YT row pulses while it accumulates) without us having to
 * stream pool-fee events. When we wire a real fee oracle later, replace
 * `usdPerSecond` with the on-chain figure and the rest of this hook is reusable.
 *
 * Math:
 *   secondsPerYear = 365.25 * 86_400  ≈ 31_557_600
 *   We use the 365-day flat figure (31_536_000) to match the rest of the codebase's
 *   simple-interest math (impliedApyPct + ptToSyRate both assume 365d/yr).
 *   $/s = ytValueUsd × (apy / 100) / secondsPerYear
 *
 * Lifecycle:
 *   • If `enabled` is false (no YT balance, or USD value unknown), we skip the
 *     interval entirely — no wasted 1Hz timer on dormant cards.
 *   • Counter resets when the component unmounts (state lives in the hook).
 *     Per spec: "vibes, not persisted" — refresh wipes the session-earned total.
 *   • Strict-mode double-mount in dev triggers two intervals briefly, but each
 *     cleanup clears its own, so the steady-state is exactly one timer.
 */

import { useEffect, useRef, useState } from "react";

const SECONDS_PER_YEAR = 31_536_000;

export interface YieldAccrualState {
  /** Per-second yield rate in USD. 0 when disabled. */
  ratePerSecond: number;
  /** Cumulative USD earned since mount. 0 when disabled. */
  earnedThisSession: number;
  /** True while the 1Hz interval is running. */
  pulsing: boolean;
}

export function useYieldAccrual(args: {
  enabled: boolean;
  ytValueUsd: number | undefined;
  apyPct: number | null;
}): YieldAccrualState {
  const { enabled, ytValueUsd, apyPct } = args;

  // Compute the rate up-front. If any input is missing/non-positive we treat
  // it as zero — the interval still ticks for visual feedback, but the running
  // total stays at $0.00.
  const ratePerSecond =
    enabled && ytValueUsd !== undefined && apyPct !== null && apyPct > 0
      ? (ytValueUsd * (apyPct / 100)) / SECONDS_PER_YEAR
      : 0;

  const [earned, setEarned] = useState(0);

  // Keep the rate in a ref so a re-render with a new apy/value doesn't restart
  // the interval — it just changes how fast each tick increments.
  const rateRef = useRef(ratePerSecond);
  rateRef.current = ratePerSecond;

  useEffect(() => {
    if (!enabled || ratePerSecond <= 0) return;
    const id = setInterval(() => {
      setEarned((prev) => prev + rateRef.current);
    }, 1000);
    return () => clearInterval(id);
    // Only the *gate* flips the interval on/off; rate changes flow via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ratePerSecond > 0]);

  return {
    ratePerSecond,
    earnedThisSession: earned,
    pulsing: enabled && ratePerSecond > 0,
  };
}

/**
 * Format a per-second rate. We deliberately show many decimals for tiny YT
 * positions ($0.000000123/s is normal for a $5 YT at 8% APY) — collapsing to
 * "$0.00 /s" would hide the live feel entirely.
 */
export function formatRatePerSecond(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "$0.00 /s";
  if (rate < 1e-7) return `$${rate.toExponential(2)} /s`;
  if (rate < 0.01) return `$${rate.toFixed(8)} /s`;
  if (rate < 1) return `$${rate.toFixed(6)} /s`;
  return `$${rate.toFixed(4)} /s`;
}

/**
 * Format a small running total. Like formatRatePerSecond but the magnitudes
 * grow over time — we still want sub-cent visibility for the first few hours
 * on a small position.
 */
export function formatEarnedTotal(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "$0.00";
  if (total < 0.0001) return `$${total.toFixed(8)}`;
  if (total < 0.01) return `$${total.toFixed(6)}`;
  if (total < 1) return `$${total.toFixed(4)}`;
  return `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
