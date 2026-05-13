"use client";

/**
 * Live trading-platform position panel for a Pendle-style market.
 *
 * Visual language: Hyperliquid / Aevo / GMX position rows. Dense vertical
 * rhythm, monospaced numerics with tabular-nums so digits stack column-style,
 * right-aligned amounts, status pills inline with the trading-pair label.
 *
 * Two big additions over the previous "stacked cards" version:
 *
 *   1. Live yield accrual ticker on the YT row. We don't have a per-block fee
 *      oracle for the underlying V3 LP yet, so v1 derives $/s from the implied
 *      APY (see `useYieldAccrual`). The counter increments every second and
 *      a pulse dot reassures the user "yes, this is alive". On unmount the
 *      session-earned total resets — explicitly vibes-grade, not persisted.
 *
 *   2. Mark vs. Projected columns. Mark is the AMM-liquidation value right
 *      now (what you'd get if you sold today via the AMM at the current
 *      implied rate). Projected is the at-maturity payout (PT redeems 1:1 to
 *      SY at maturity, so projected PT = userPt × usdPerShare). We deliberately
 *      do not surface a P&L number because we have no entry-price oracle —
 *      showing a "$0.00 (+0.00%) P&L" line would be misleading. When we add
 *      position-open events later we can swap the placeholder for real P&L.
 *
 * Math
 * ----
 * Pendle math: 1 SY = 1 PT + 1 YT at maturity, and the AMM prices them so
 * that ptPrice + ytPrice == 1 SY. We compute PT→SY purely from implied APY
 * and time-to-maturity (simple interest matches the rest of the codebase).
 * USD values come from `usdPerShare`, already computed by `useSyValueUsd`
 * against the underlying V3 LP.
 *
 * For LP value we compute the user's pro-rata share of `totalPt` and
 * `totalSy` in the AMM, value the PT side at its discounted SY rate, and
 * sum: `(userPtInLp * ptToSyRate + userSyInLp) * usdPerShare`.
 *
 * usdPerShare is `undefined` for SYs that don't expose the V3 LP shape
 * (HBARX etc.). In that case we hide every "≈ $X.XX" line — never show $0
 * for unknown — and the top "Position value" line disappears too.
 */

import Link from "next/link";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { formatUsd } from "@/hooks/useSyValueUsd";
import {
  formatEarnedTotal,
  formatRatePerSecond,
  useYieldAccrual,
} from "@/hooks/useYieldAccrual";

export interface UserPosition {
  sy: bigint;
  pt: bigint;
  yt: bigint;
  lp: bigint;
  claimableYield: bigint;
}

interface Props {
  detail: MarketDetail;
  position: UserPosition | undefined;
  /** $-per-raw-share for the underlying SY. undefined → hide all USD lines. */
  usdPerShare: number | undefined;
  /**
   * When set, the header SY-name becomes a Link to this href. Used on the
   * profile page to navigate from card → market detail. On the market detail
   * page itself we pass `undefined` (we're already there).
   */
  marketLink?: string;
  /**
   * Action button hrefs are built from this base. Same as the market detail
   * route — buttons append ?strategy= / ?action= query strings.
   * Required.
   */
  market: `0x${string}`;
}

/* ─────────────────────────────────────────────────────── math helpers */

/**
 * Pendle-style PT→SY rate. PT trades at a discount: 1 PT redeems for 1 SY
 * at maturity, so today it should cost < 1 SY. With t days to maturity and
 * an implied APY of r, simple-interest price = 1 / (1 + r·t/365).
 *
 * Returns 1 (i.e. par) when:
 *   • APY is unknown (e.g. an empty market with no swaps yet)
 *   • maturity has arrived (days ≤ 0)
 */
export function ptToSyRate(apyPct: number | null, days: number): number {
  if (apyPct === null || days <= 0) return 1;
  return 1 / (1 + (apyPct / 100) * (days / 365));
}

/**
 * YT→SY rate. By Pendle identity, ptPrice + ytPrice = 1 SY, so
 * ytPrice = 1 − ptPrice.
 */
export function ytToSyRate(apyPct: number | null, days: number): number {
  return 1 - ptToSyRate(apyPct, days);
}

/* ─────────────────────────────────────────────────────── trading-pair label */

/**
 * Derive a "USDC/WHBAR" style pair from the SY name. Our SYs are named
 * "SY-SaucerSwap V2 USDC/WHBAR 0.30%" or similar. We greedily grab the first
 * `A/B` token on the line; if it can't be found we fall back to the full
 * SY name so the header is never blank.
 */
function extractPair(syName: string): string {
  const m = syName.match(/([A-Z0-9]{2,10})\s*\/\s*([A-Z0-9]{2,10})/);
  return m ? `${m[1]}/${m[2]}` : syName;
}

/* ─────────────────────────────────────────────────────── component */

export function MarketPositionCard({
  detail,
  position,
  usdPerShare,
  marketLink,
  market,
}: Props) {
  const expired = Date.now() / 1000 >= Number(detail.expiry);
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ptRate = ptToSyRate(apy, days);
  const ytRate = ytToSyRate(apy, days);

  // Default position to zeros so the card still renders the four rows
  // (dimmed) even when the user has no balance. Per spec: never hide rows.
  const p: UserPosition = position ?? { sy: 0n, pt: 0n, yt: 0n, lp: 0n, claimableYield: 0n };

  // Pro-rata LP composition. `lpSupply` is the LP HTS token's totalSupply.
  // Guard the divisor — a freshly deployed market with no liquidity yet
  // has 0 supply, in which case the user can't possibly own any LP.
  const lpSupply = detail.lpSupply;
  const hasLp = lpSupply > 0n && p.lp > 0n;
  const userPtInLp = hasLp ? (p.lp * detail.totalPt) / lpSupply : 0n;
  const userSyInLp = hasLp ? (p.lp * detail.totalSy) / lpSupply : 0n;
  const poolSharePct = hasLp
    ? (Number(p.lp) / Number(lpSupply)) * 100
    : null;

  // ─── MARK values (what the position liquidates for *right now*). For PT and
  // YT this routes through the AMM's implied rate; for SY it's the underlying
  // V3-LP basket valuation; for LP it's the decomposed PT+SY.
  const markSy = usdPerShare !== undefined ? Number(p.sy) * usdPerShare : undefined;
  const markPt =
    usdPerShare !== undefined ? Number(p.pt) * ptRate * usdPerShare : undefined;
  const markYt =
    usdPerShare !== undefined ? Number(p.yt) * ytRate * usdPerShare : undefined;
  const markLp =
    usdPerShare !== undefined && hasLp
      ? (Number(userPtInLp) * ptRate + Number(userSyInLp)) * usdPerShare
      : usdPerShare !== undefined
        ? 0
        : undefined;
  const usdClaim =
    usdPerShare !== undefined
      ? Number(p.claimableYield) * usdPerShare
      : undefined;

  // ─── PROJECTED at-maturity payout. Only PT has a deterministic at-maturity
  // value (1 PT → 1 SY). YT decays to 0 at maturity. LP and SY don't have a
  // single "maturity payout" — LP unwinds to its PT+SY composition which is
  // path-dependent on the AMM trajectory.
  const projectedPt = usdPerShare !== undefined ? Number(p.pt) * usdPerShare : undefined;
  const projectedPtGain =
    projectedPt !== undefined && markPt !== undefined ? projectedPt - markPt : undefined;

  const positionMark =
    markSy !== undefined &&
    markPt !== undefined &&
    markYt !== undefined &&
    markLp !== undefined &&
    usdClaim !== undefined
      ? markSy + markPt + markYt + markLp + usdClaim
      : undefined;

  // Sum the at-maturity payout the same way we do mark: PT redeems 1:1, YT → 0,
  // SY stays at mark, LP keeps its SY leg but its PT leg pulls to par. The
  // "+claim" amount is realized whenever the user claims; we treat it as
  // payout-equivalent.
  const projectedSy = markSy;
  const projectedLp =
    usdPerShare !== undefined && hasLp
      ? (Number(userPtInLp) + Number(userSyInLp)) * usdPerShare
      : usdPerShare !== undefined
        ? 0
        : undefined;
  const positionProjected =
    projectedSy !== undefined &&
    projectedPt !== undefined &&
    projectedLp !== undefined &&
    usdClaim !== undefined
      ? projectedSy + projectedPt + 0 /* YT → 0 */ + projectedLp + usdClaim
      : undefined;

  // ─── Live YT yield accrual. Gated to YT-positive positions where we know the
  // dollar value — otherwise we'd be computing the integral of nothing per
  // second and burning a 1Hz timer for no benefit.
  const accrual = useYieldAccrual({
    enabled: !expired && p.yt > 0n && markYt !== undefined && markYt > 0,
    ytValueUsd: markYt,
    apyPct: apy,
  });

  const pair = extractPair(detail.syName);
  const apyLabel = apy !== null ? `${apy.toFixed(2)}%` : "—";
  const matures = new Date(Number(detail.expiry) * 1000).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", year: "numeric" },
  );

  // Action hrefs — link to the dedicated strategy sub-pages introduced in
  // Phase 3. Post-expiry redeem is the only action that stays on the
  // overview route (the redeem CTA lives there).
  const sub = (segment: "pt" | "yt" | "lp" | "") =>
    segment ? `/markets/${market}/${segment}` : `/markets/${market}`;

  // Overall status pill. EXPIRED dominates; ACCRUING wins over OPEN when the
  // user has a live YT position; otherwise OPEN.
  const status = expired
    ? { label: "EXPIRED", tone: "error" as const }
    : accrual.pulsing
      ? { label: "ACCRUING", tone: "warning" as const }
      : positionMark !== undefined && positionMark > 0
        ? { label: "OPEN", tone: "success" as const }
        : { label: "EMPTY", tone: "neutral" as const };

  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-bgCard transition hover:border-borderHover"
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {/* ─── TOP STRIP: trading-pair · PT/YT · 81d · 8.33% ─────────────── */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-white/[0.015] px-4 py-2.5 text-[11px] font-medium">
        {marketLink ? (
          <Link
            href={marketLink}
            className="font-mono text-[12px] font-semibold tracking-tight text-text transition hover:opacity-80"
          >
            {pair}
          </Link>
        ) : (
          <span className="font-mono text-[12px] font-semibold tracking-tight text-text">
            {pair}
          </span>
        )}
        <Sep />
        <span className="font-mono text-textSec">PT/YT</span>
        <Sep />
        <span className="font-mono text-textSec">
          {expired ? "matured" : `${days}d`}
        </span>
        <Sep />
        <span className="font-mono text-accent">{apyLabel}</span>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="hidden font-mono text-[10px] text-textDim sm:inline">
            {matures}
          </span>
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
        </span>
      </div>

      {/* ─── HEADER ROW: position value | mark | projected ─────────────── */}
      <div className="grid grid-cols-3 gap-x-3 border-b border-border bg-white/[0.025] px-4 py-3">
        <Stat
          label="Position value"
          value={formatUsd(positionMark) ?? "—"}
          tone="text"
        />
        <Stat
          label="Mark"
          value={formatUsd(positionMark) ?? "—"}
          tone="textSec"
        />
        <Stat
          label={expired ? "Payout (matured)" : `Payout @ ${days}d`}
          value={formatUsd(positionProjected) ?? "—"}
          tone={
            positionProjected !== undefined &&
            positionMark !== undefined &&
            positionProjected > positionMark
              ? "success"
              : "textSec"
          }
        />
      </div>

      {/* ─── PER-TOKEN ROWS ────────────────────────────────────────────── */}
      <RowGroup>
        <PositionRow
          label="PT"
          tone="success"
          rawCount={p.pt}
          markUsd={markPt}
          rightSlot={
            expired ? (
              <span className="text-textSec">Redeems 1:1 to SY</span>
            ) : projectedPt !== undefined ? (
              <span className="text-textSec">
                Payout @{days}d{" "}
                <span className="font-mono text-text">
                  {formatUsd(projectedPt)}
                </span>
                {projectedPtGain !== undefined && projectedPtGain > 0.0001 && (
                  <span className="ml-1 font-mono text-success">
                    +{formatUsd(projectedPtGain)}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-textSec">Fixed APY {apyLabel}</span>
            )
          }
          actions={
            expired
              ? [{ label: "Redeem PT", href: sub("") }]
              : [{ label: "Sell PT", href: sub("pt") }]
          }
          dim={p.pt === 0n}
        />

        <PositionRow
          label="YT"
          tone="warning"
          pulse={accrual.pulsing}
          rawCount={p.yt}
          markUsd={markYt}
          rightSlot={
            accrual.pulsing ? (
              <span className="text-textSec">
                Earning{" "}
                <span className="font-mono text-warning">
                  {formatRatePerSecond(accrual.ratePerSecond)}
                </span>
              </span>
            ) : (
              <span className="text-textSec">
                Implied APY {apyLabel}
                {p.claimableYield > 0n && (
                  <>
                    {" "}
                    <span className="text-textDim">·</span>{" "}
                    Claimable{" "}
                    <span className="font-mono text-text">
                      {formatCompact(p.claimableYield)}
                    </span>
                    {formatUsd(usdClaim) && (
                      <span className="ml-1 font-mono text-textDim">
                        ({formatUsd(usdClaim)})
                      </span>
                    )}
                  </>
                )}
              </span>
            )
          }
          actions={[
            { label: "Sell YT", href: sub("yt") },
            ...(p.claimableYield > 0n
              ? [{ label: "Claim yield", href: sub("") }]
              : []),
          ]}
          dim={p.yt === 0n && p.claimableYield === 0n}
        />

        <PositionRow
          label="LP"
          tone="neutral"
          rawCount={p.lp}
          markUsd={markLp}
          rightSlot={
            <span className="text-textSec">
              Pool share{" "}
              <span className="font-mono text-text">
                {poolSharePct !== null
                  ? `${poolSharePct < 0.01 ? "<0.01" : poolSharePct.toFixed(2)}%`
                  : "—"}
              </span>
              {hasLp && (
                <span className="ml-1 text-textDim">
                  ({formatCompact(userPtInLp)} PT / {formatCompact(userSyInLp)}{" "}
                  SY)
                </span>
              )}
            </span>
          }
          actions={[{ label: "Add liquidity", href: sub("lp") }]}
          dim={p.lp === 0n}
        />

        <PositionRow
          label="SY"
          tone="neutral"
          rawCount={p.sy}
          markUsd={markSy}
          rightSlot={
            <span className="text-textDim">unwrap → USDC + WHBAR</span>
          }
          actions={[
            { label: "Mint more", href: sub("") },
            { label: "Buy PT", href: sub("pt") },
          ]}
          dim={p.sy === 0n}
        />
      </RowGroup>

      {/* ─── FOOTER: session earned + open market ─────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border bg-white/[0.02] px-4 py-2.5 text-[11px]">
        {accrual.pulsing ? (
          <span className="inline-flex items-center gap-1.5 text-textSec">
            <span className="font-mono text-[10px] uppercase tracking-[1px] text-textDim">
              Session earned
            </span>
            <span className="font-mono text-warning">
              {formatEarnedTotal(accrual.earnedThisSession)}
            </span>
            <span className="font-mono text-success">↗</span>
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[1px] text-textDim">
            {expired ? "Market expired" : "Awaiting YT position"}
          </span>
        )}
        <Link
          href={`/markets/${market}`}
          className="inline-flex items-center gap-1 font-medium text-textSec transition hover:text-text"
        >
          Open market →
        </Link>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── pieces */

function Sep() {
  return <span className="text-textDim/60">·</span>;
}

function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "error" | "neutral";
  children: React.ReactNode;
}) {
  const palette =
    tone === "success"
      ? "border-success/30 bg-success/10 text-success"
      : tone === "warning"
        ? "border-warning/30 bg-warning/10 text-warning"
        : tone === "error"
          ? "border-error/30 bg-error/10 text-error"
          : "border-border bg-white/[0.04] text-textDim";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1.5px] ${palette}`}
    >
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "text" | "textSec" | "success";
}) {
  const colour =
    tone === "success"
      ? "text-success"
      : tone === "textSec"
        ? "text-textSec"
        : "text-text";
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[1.5px] text-textDim">
        {label}
      </div>
      <div className={`mt-0.5 truncate font-mono text-[15px] font-semibold ${colour}`}>
        {value}
      </div>
    </div>
  );
}

function RowGroup({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

/* ─────────────────────────────────────────────────────── row */

interface RowAction {
  label: string;
  href: string;
}

interface RowProps {
  label: string;
  tone: "success" | "warning" | "neutral";
  rawCount: bigint;
  markUsd: number | undefined;
  /** Right-hand column: contextual hint (e.g. "Earning $0.000…123 /s"). */
  rightSlot: React.ReactNode;
  actions: RowAction[];
  /** Dim the whole row when the user holds 0 of this position. */
  dim?: boolean;
  /** When true, show a pulsing dot next to the label. YT-only. */
  pulse?: boolean;
}

function PositionRow({
  label,
  tone,
  rawCount,
  markUsd,
  rightSlot,
  actions,
  dim,
  pulse,
}: RowProps) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : "text-text";
  const pulseDot =
    tone === "success"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : "bg-accent";
  const usdLabel = formatUsd(markUsd);

  return (
    <div
      className={`group flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-white/[0.015] px-4 py-2 text-[12px] transition hover:bg-white/[0.035] ${dim ? "opacity-50" : ""}`}
    >
      {/* Label + optional pulse */}
      <div className="flex w-12 flex-shrink-0 items-center gap-1.5">
        {pulse && (
          <span
            className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${pulseDot} animate-pulse`}
            aria-hidden
          />
        )}
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.5px] text-textDim">
          {label}
        </span>
      </div>

      {/* Raw count — tabular-aligned */}
      <div className={`w-20 flex-shrink-0 text-right font-mono text-[13px] font-semibold ${toneClass}`}>
        {formatCompact(rawCount)}
      </div>

      {/* Mark USD column — fixed-width so columns stack across all 4 rows */}
      <div className="w-24 flex-shrink-0 text-right">
        <span className="font-mono text-[9px] uppercase tracking-[1px] text-textDim">
          Mark{" "}
        </span>
        <span className="font-mono text-[12px] font-medium text-text">
          {usdLabel ?? "—"}
        </span>
      </div>

      {/* Right slot: payout / earning rate / pool composition */}
      <div className="min-w-0 flex-1 text-[11px] leading-snug">{rightSlot}</div>

      {/* Actions */}
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {actions.map((a) => (
            <Link
              key={a.label}
              href={a.href}
              className="rounded border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[1px] text-textSec transition hover:border-borderHover hover:bg-white/[0.08] hover:text-text"
            >
              {a.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
