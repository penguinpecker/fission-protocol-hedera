"use client";

/**
 * Pendle-style stacked position card. Used by both:
 *   • /profile           (one card per market the user has any position in)
 *   • /markets/[address] (one card at the top showing the user's position)
 *
 * The card renders four sub-rows (PT, YT, LP, SY) plus a header with the
 * market name + total $-value. Each sub-row shows the raw count, an
 * approximate USD value, a one-liner contextual hint, and 1-2 action buttons
 * that deep-link back into the market detail page with a strategy/action
 * preselected.
 *
 * Math
 * ----
 * Pendle math: 1 SY = 1 PT + 1 YT at maturity, and the AMM prices them so
 * that ptPrice + ytPrice == 1 SY. We compute PT→SY purely from implied APY
 * and time-to-maturity (continuous compounding feels overkill for a UI hint;
 * simple interest matches the spec). USD values come from `usdPerShare`
 * which is already computed by `useSyValueUsd` against the underlying V3 LP.
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

  // USD breakdown. Only meaningful when usdPerShare is defined; otherwise
  // all the hints are null and we skip the header total.
  const usdSy = usdPerShare !== undefined ? Number(p.sy) * usdPerShare : undefined;
  const usdPt =
    usdPerShare !== undefined ? Number(p.pt) * ptRate * usdPerShare : undefined;
  const usdYt =
    usdPerShare !== undefined ? Number(p.yt) * ytRate * usdPerShare : undefined;
  const usdLp =
    usdPerShare !== undefined && hasLp
      ? (Number(userPtInLp) * ptRate + Number(userSyInLp)) * usdPerShare
      : usdPerShare !== undefined
        ? 0
        : undefined;
  const usdClaim =
    usdPerShare !== undefined
      ? Number(p.claimableYield) * usdPerShare
      : undefined;
  const positionUsd =
    usdSy !== undefined &&
    usdPt !== undefined &&
    usdYt !== undefined &&
    usdLp !== undefined &&
    usdClaim !== undefined
      ? usdSy + usdPt + usdYt + usdLp + usdClaim
      : undefined;

  const fmtUsd = (n: number | undefined) => formatUsd(n);
  const apyLabel = apy !== null ? `${apy.toFixed(2)}%` : "—";
  const matures = new Date(Number(detail.expiry) * 1000).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", year: "numeric" },
  );

  // Action hrefs — link back into the market detail page with the right
  // strategy preselected (the TradeCard reads state, not URL, today — so
  // these query params are forward-looking; mention in the report).
  const h = (qs: string) => `/markets/${market}?${qs}`;

  const Header = () => (
    <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-4">
      <div>
        {marketLink ? (
          <Link
            href={marketLink}
            className="text-[15px] font-semibold tracking-tight text-text transition hover:opacity-80"
          >
            {detail.syName}
          </Link>
        ) : (
          <span className="text-[15px] font-semibold tracking-tight text-text">
            {detail.syName}
          </span>
        )}
        <div className="mt-0.5 text-[11px] text-textDim">
          {expired ? (
            <span className="text-error">Expired</span>
          ) : (
            <>
              {days} days · matures {matures}
            </>
          )}
        </div>
      </div>
      <div className="text-right">
        {positionUsd !== undefined && (
          <>
            <div className="text-[10px] uppercase tracking-[1px] text-textDim">
              Position value
            </div>
            <div className="mt-0.5 font-mono text-[16px] font-semibold text-text">
              {fmtUsd(positionUsd)}
            </div>
          </>
        )}
        <div className={`${positionUsd !== undefined ? "mt-1.5" : ""} text-[10px] uppercase tracking-[1px] text-textDim`}>
          Implied APY {apyLabel}
        </div>
      </div>
    </div>
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bgCard transition hover:border-borderHover">
      <Header />

      <PositionRow
        label="PT"
        tone="success"
        rawCount={p.pt}
        usd={usdPt}
        meta={
          <>
            <span className="text-textSec">Fixed APY {apyLabel}</span>
            <span className="text-textDim"> · Redeems 1:1 SY at maturity</span>
          </>
        }
        actions={
          expired
            ? [{ label: "Redeem PT", href: h("action=redeem") }]
            : [{ label: "Sell PT", href: h("strategy=pt") }]
        }
        dim={p.pt === 0n}
      />

      <PositionRow
        label="YT"
        tone="warning"
        rawCount={p.yt}
        usd={usdYt}
        meta={
          <>
            <span className="text-textSec">Implied APY {apyLabel}</span>
            <span className="text-textDim">
              {" "}
              · Claimable {formatCompact(p.claimableYield)}
              {fmtUsd(usdClaim) ? ` (≈ ${fmtUsd(usdClaim)})` : ""}
            </span>
          </>
        }
        actions={[
          { label: "Sell YT", href: h("strategy=yt") },
          ...(p.claimableYield > 0n
            ? [{ label: "Claim yield", href: h("action=claim") }]
            : []),
        ]}
        dim={p.yt === 0n && p.claimableYield === 0n}
      />

      <PositionRow
        label="LP"
        tone="neutral"
        rawCount={p.lp}
        usd={usdLp}
        meta={
          <>
            <span className="text-textSec">
              Composition:{" "}
              {hasLp ? formatCompact(userPtInLp) : "—"} PT /{" "}
              {hasLp ? formatCompact(userSyInLp) : "—"} SY
            </span>
            <span className="text-textDim">
              {" "}
              · Pool share{" "}
              {poolSharePct !== null
                ? `${poolSharePct < 0.01 ? "<0.01" : poolSharePct.toFixed(2)}%`
                : "—"}
            </span>
          </>
        }
        actions={[{ label: "Add liquidity", href: h("action=lp") }]}
        dim={p.lp === 0n}
      />

      <PositionRow
        label="SY"
        tone="neutral"
        rawCount={p.sy}
        usd={usdSy}
        meta={null}
        actions={[
          { label: "Mint more", href: h("strategy=mint") },
          { label: "Split → PT + YT", href: h("strategy=split") },
        ]}
        dim={p.sy === 0n}
      />

      <div className="border-t border-border bg-white/[0.02] px-5 py-3">
        <Link
          href={`/markets/${market}`}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-textSec transition hover:text-text"
        >
          Open market →
        </Link>
      </div>
    </div>
  );
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
  usd: number | undefined;
  /** Sub-line under the value (e.g. "Fixed APY 8.33%"). Pass `null` to omit. */
  meta: React.ReactNode | null;
  actions: RowAction[];
  /** Dim the whole row when the user holds 0 of this position. */
  dim?: boolean;
}

function PositionRow({ label, tone, rawCount, usd, meta, actions, dim }: RowProps) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : "text-text";
  const usdLabel = formatUsd(usd);
  return (
    <div
      className={`border-t border-border bg-white/[0.02] px-5 py-4 ${dim ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="w-10 flex-shrink-0 text-[10px] font-semibold uppercase tracking-[1.5px] text-textDim">
          {label}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <div className={`font-mono text-[16px] font-semibold ${toneClass}`}>
              {formatCompact(rawCount)}
            </div>
            {usdLabel && (
              <div className="font-mono text-[12px] font-medium text-textDim">
                ≈ {usdLabel}
              </div>
            )}
          </div>
          {meta && (
            <div className="mt-1 text-[11px] leading-relaxed">{meta}</div>
          )}
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {actions.map((a) => (
              <Link
                key={a.label}
                href={a.href}
                className="rounded-lg border border-border bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-textSec transition hover:border-borderHover hover:bg-white/[0.06] hover:text-text"
              >
                {a.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
