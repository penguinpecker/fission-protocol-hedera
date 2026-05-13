"use client";

import Link from "next/link";
import { useState } from "react";
import { useChainId } from "wagmi";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletGate } from "@/components/WalletGate";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import {
  useMarketCount,
  useMarketAddresses,
  useMarketDetails,
  useLpMetadata,
  useSyMetadata,
  impliedApyPct,
  daysUntil,
  formatCompact,
} from "@/hooks/useMarkets";
import { useWatchlist } from "@/hooks/useWatchlist";
import { useCachedMarkets } from "@/hooks/useCachedMarkets";
import { useSyValueUsd, formatUsd } from "@/hooks/useSyValueUsd";
import { getMarketDisplay, getAssetColor } from "@/lib/markets-metadata";

const factoryDeployed = isDeployed(ADDRESSES.factory);

/**
 * Markets list — each market is a full-width "expanded row" card. The visual
 * shape mirrors the Pendle V2 list at 1.5× height: lockup progress + chips on
 * the left, a single hero APY number with a 0-15% scale bar in the middle, a
 * sparkline + bottom-strip stats on the right. Hover lifts the card with a
 * subtle radial glow + a one-pixel border brighten.
 *
 * Heavy lifting per row (the USD TVL via Uniswap V3 LP math) is delegated to
 * the `MarketRowCard` component so each `useSyValueUsd` call sits inside its
 * own component instance — React's hook rules require fixed call ordering per
 * component, which a `.map()` over rows can't give us.
 */
export default function MarketsPage() {
  const chainId = useChainId();

  const { markets: cached, loading: cachedLoading } = useCachedMarkets();
  const useChainFallback = !cachedLoading && (cached === null || cached.length === 0);

  const { data: countRaw } = useMarketCount();
  const count = countRaw as bigint | undefined;

  const { data: addressesRaw } = useMarketAddresses(useChainFallback ? count : undefined);
  const addresses = addressesRaw as readonly `0x${string}`[] | undefined;

  const { data: detailsRaw, isLoading: detailsLoading } = useMarketDetails(
    useChainFallback ? addresses : undefined,
  );
  const syAddrs =
    addresses && detailsRaw
      ? addresses.map((_, i) => detailsRaw[i * 6] as `0x${string}`)
      : undefined;
  const lpAddrs =
    addresses && detailsRaw
      ? addresses.map((_, i) => detailsRaw[i * 6 + 1] as `0x${string}`)
      : undefined;
  const { data: syMetaRaw } = useSyMetadata(syAddrs);
  const { data: lpMetaRaw } = useLpMetadata(lpAddrs);

  const allMarkets =
    cached && cached.length > 0
      ? buildRowsFromCache(cached)
      : buildMarketRows(addresses, detailsRaw, syMetaRaw, lpMetaRaw);

  const { isWatched, toggle, signedIn, items } = useWatchlist();
  const [showWatchedOnly, setShowWatchedOnly] = useState(false);

  const markets = showWatchedOnly
    ? allMarkets.filter((m) => isWatched(chainId, m.address))
    : allMarkets;

  return (
    <main className="min-h-screen">
      <Nav />

      <WalletGate>
        <section className="mx-auto max-w-[1180px] px-6 py-10">
          <header className="mb-9 flex items-end justify-between gap-6">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-white/[0.03] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[2px] text-textDim">
                <span className="size-[5px] rounded-full bg-success" />
                <span>[LIVE · HEDERA MAINNET]</span>
              </div>
              <h1 className="text-[34px] font-light leading-none tracking-[-1px]">
                Yield <span className="font-serif italic">markets</span>
              </h1>
              <p className="mt-3 max-w-[520px] text-sm font-light leading-relaxed text-textDim">
                Split yield-bearing assets · Trade fixed vs variable rate · Earn LP fees
              </p>
            </div>
            {signedIn && allMarkets.length > 0 && (
              <button
                type="button"
                onClick={() => setShowWatchedOnly((v) => !v)}
                className={`rounded-xl border px-4 py-2 text-[12px] font-medium transition ${
                  showWatchedOnly
                    ? "border-borderHover bg-white/[0.04] text-text"
                    : "border-border text-textSec hover:border-borderHover hover:text-text"
                }`}
              >
                {showWatchedOnly ? "All markets" : `Watchlist (${items.length})`}
              </button>
            )}
          </header>

          {!factoryDeployed && <NotDeployed />}

          {factoryDeployed && useChainFallback && count === 0n && <EmptyState />}

          {factoryDeployed && (cachedLoading || (useChainFallback && detailsLoading)) && <Loading />}

          {factoryDeployed && !detailsLoading && allMarkets.length > 0 && markets.length === 0 && (
            <WatchlistEmpty onShowAll={() => setShowWatchedOnly(false)} />
          )}

          {markets.length > 0 && (
            <div className="flex flex-col gap-3">
              {markets.map((m) => (
                <MarketRowCard
                  key={m.address}
                  row={m}
                  watched={isWatched(chainId, m.address)}
                  signedIn={signedIn}
                  onToggleWatch={() => toggle(chainId, m.address)}
                />
              ))}
            </div>
          )}
        </section>
      </WalletGate>
      <Footer />
    </main>
  );
}

/* ─────────────────────────────────────────────────────── row card */

interface MarketRow {
  address: `0x${string}`;
  syAddress: `0x${string}` | undefined;
  syName?: string;
  syDecimals: number;
  symbol: string;
  totalSy: bigint;
  totalPt: bigint;
  lpSupply: bigint;
  impliedApy: number;
  daysLeft: number;
  expiryDate: string;
}

/**
 * One row in the markets list. Lives in its own component so the per-row
 * `useSyValueUsd` hook has a stable call site (hooks-in-loops would break the
 * React rules-of-hooks invariant on re-render).
 */
function MarketRowCard({
  row,
  watched,
  signedIn,
  onToggleWatch,
}: {
  row: MarketRow;
  watched: boolean;
  signedIn: boolean;
  onToggleWatch: () => void;
}) {
  const meta = getMarketDisplay(row.address);
  const label = meta?.displayName ?? row.syName ?? row.symbol;
  // The CoinGecko + Uniswap V3 reads inside useSyValueUsd are gated on the SY
  // matching the LP-SY shape — for HBARX-style adapters the hook fast-exits with
  // usdPerShare === undefined and we just hide the $ TVL chip. The CoinGecko
  // call is module-cached, so N rows = 1 HBAR fetch.
  const { usdPerShare } = useSyValueUsd(row.syAddress);
  const tvlUsd =
    usdPerShare !== undefined && row.totalSy > 0n
      ? Number(row.totalSy) * usdPerShare
      : undefined;
  const tvlDisplay = formatUsd(tvlUsd);

  // Maturity progress. Without an indexed start-timestamp we fall back to
  // assuming a 90-day standard term so the bar still gives a visual sense of
  // "how late are we in this market's life". When the term shortens, the bar
  // fills and the warning tone kicks in.
  const ASSUMED_TERM_DAYS = 90;
  const elapsedRatio = Math.min(
    1,
    Math.max(0, (ASSUMED_TERM_DAYS - row.daysLeft) / ASSUMED_TERM_DAYS),
  );
  const lowTime = row.daysLeft <= 14;

  // 0-15% APY scale: most stable-pair yields land in that band. Above 15% we
  // saturate the bar (and the user will still see the exact number alongside).
  const apyScale = Math.min(1, Math.max(0, row.impliedApy / 15));

  return (
    <article className="group relative overflow-hidden rounded-2xl border border-border bg-bgCard transition hover:border-borderHover hover:bg-white/[0.02]">
      {/* hover halo */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -top-32 size-72 rounded-full bg-[radial-gradient(circle,rgba(125,211,252,0.10),transparent_65%)] opacity-0 transition duration-300 group-hover:opacity-100"
      />
      {/* grid backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.035] [background-image:linear-gradient(to_right,#fff_1px,transparent_1px),linear-gradient(to_bottom,#fff_1px,transparent_1px)] [background-size:48px_48px]"
      />

      {/* full-card click target */}
      <Link
        href={`/markets/${row.address}`}
        className="absolute inset-0 z-10 rounded-2xl"
        aria-label={`View ${label}`}
      />

      <div className="relative z-20 grid grid-cols-[auto_minmax(0,2.6fr)_minmax(0,1.5fr)_minmax(0,1.4fr)] items-stretch gap-6 px-6 py-5">
        {/* col 1 — watchlist star */}
        <div className="pointer-events-auto flex items-start pt-1">
          <StarButton watched={watched} signedIn={signedIn} onClick={onToggleWatch} />
        </div>

        {/* col 2 — identity + chips + maturity progress */}
        <div className="pointer-events-none flex flex-col justify-between gap-4 min-w-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[18px] font-semibold tracking-tight">{label}</span>
              {meta?.assets.map((a) => {
                const c = getAssetColor(a);
                return (
                  <span
                    key={a}
                    className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1px] ${c.chip}`}
                  >
                    {a}
                  </span>
                );
              })}
              {meta && (
                <span className="rounded-full border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1.5px] text-textDim">
                  {meta.protocol}
                  {meta.poolFeePct !== undefined && ` · ${meta.poolFeePct}%`}
                </span>
              )}
            </div>
            <div className="mt-2 text-[12px] leading-relaxed text-textSec">
              {meta?.yieldSource ?? "Tokenized yield"}
            </div>
          </div>

          {/* maturity progress + countdown */}
          <div>
            <div className="mb-1.5 flex items-end justify-between font-mono text-[10px] uppercase tracking-[1.2px] text-textDim">
              <span>Maturity</span>
              <span className={lowTime ? "text-warning" : "text-textSec"}>
                {row.daysLeft}d · {row.expiryDate}
              </span>
            </div>
            <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className={`h-full transition-all ${lowTime ? "bg-warning" : "bg-textSec/70"}`}
                style={{ width: `${elapsedRatio * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* col 3 — hero APY + 0-15% scale bar */}
        <div className="pointer-events-none flex flex-col justify-center">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[2px] text-textDim">
            [FIXED APY]
          </div>
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-[38px] font-bold leading-none tracking-tight text-text">
              {row.impliedApy.toFixed(2)}
            </span>
            <span className="font-mono text-[16px] font-semibold text-textDim">%</span>
          </div>
          <div className="mt-3">
            <div className="h-[5px] w-full overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className="h-full bg-gradient-to-r from-accent/60 to-accent"
                style={{ width: `${apyScale * 100}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[8px] uppercase tracking-[1.5px] text-textDim">
              <span>0%</span>
              <span>15%</span>
            </div>
          </div>
        </div>

        {/* col 4 — sparkline + bottom stats */}
        <div className="pointer-events-none flex flex-col justify-between gap-3">
          <ApySparkline apy={row.impliedApy} />
          <div className="grid grid-cols-3 gap-2 border-t border-border pt-2.5">
            <MiniStat
              label="TVL"
              value={tvlDisplay ?? formatCompact(row.totalSy)}
              accent={tvlDisplay ? "white" : "silver"}
            />
            <MiniStat label="SY" value={formatCompact(row.totalSy)} accent="silver" />
            <MiniStat label="Liq" value={formatCompact(row.lpSupply)} accent="silver" />
          </div>
        </div>
      </div>
    </article>
  );
}

/* ─────────────────────────────────────────────────────── sparkline */

/**
 * 140×40 SVG APY sparkline. Uses the same seeded-random walk pattern as the YT
 * card in `StrategyOverview` so the visual language stays consistent — kept
 * inline rather than imported so we can tweak the dimensions without touching
 * the strategy card. Deterministic per-APY: the seed is `Math.floor(apy*100)`,
 * which means re-renders with the same APY produce the same wiggle.
 */
function ApySparkline({ apy }: { apy: number }) {
  const W = 160;
  const H = 44;
  const padL = 4;
  const padR = 30;
  const padT = 4;
  const padB = 12;
  const N = 28;

  const seed = Math.max(1, Math.floor(apy * 100));
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 10_000) / 10_000;
  };

  const band = apy * 0.15 + 0.4;
  const series: number[] = [];
  let v = apy;
  for (let i = 0; i < N; i++) {
    const step = (rand() - 0.5) * band * 0.4;
    v = v + step;
    v = v + (apy - v) * 0.14;
    series.push(v);
  }
  const lo = Math.min(...series, apy - band);
  const hi = Math.max(...series, apy + band);
  const range = Math.max(1e-6, hi - lo);

  const x = (i: number) => padL + ((W - padL - padR) * i) / (N - 1);
  const y = (val: number) => padT + (H - padT - padB) * (1 - (val - lo) / range);

  const d = series
    .map((val, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(val).toFixed(2)}`)
    .join(" ");
  const lastX = x(N - 1);
  const lastVal = series[series.length - 1] ?? apy;
  const lastY = y(lastVal);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-[44px] w-full text-accent"
      role="img"
      aria-label={`APY sparkline near ${apy.toFixed(2)}%`}
    >
      <line
        x1={padL}
        y1={y(apy)}
        x2={W - padR}
        y2={y(apy)}
        stroke="currentColor"
        strokeOpacity={0.18}
        strokeDasharray="2 3"
      />
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r={2.5} fill="currentColor" />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────── bits */

function MiniStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "white" | "silver";
}) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[8px] uppercase tracking-[1.5px] text-textDim">{label}</div>
      <div
        className={`mt-0.5 truncate font-mono text-[12px] font-bold tracking-tight ${
          accent === "white" ? "text-text" : "text-silver"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function StarButton({
  watched,
  signedIn,
  onClick,
}: {
  watched: boolean;
  signedIn: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      disabled={!signedIn}
      title={signedIn ? (watched ? "Remove from watchlist" : "Add to watchlist") : "Sign in to use watchlist"}
      className={`relative z-10 grid size-8 place-items-center rounded-lg transition ${
        signedIn
          ? watched
            ? "text-warning hover:bg-white/[0.05]"
            : "text-textDim hover:bg-white/[0.05] hover:text-text"
          : "cursor-not-allowed text-textDim opacity-40"
      }`}
      aria-pressed={watched}
      aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill={watched ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    </button>
  );
}

function WatchlistEmpty({ onShowAll }: { onShowAll: () => void }) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-border bg-bgCard p-10 text-center">
      <div className="mb-2 text-base font-semibold">No watched markets yet</div>
      <p className="mb-5 max-w-[420px] text-sm text-textSec">
        Star a market on the all-markets view to add it here. Your watchlist is per-wallet and
        synced across devices once you&rsquo;re signed in.
      </p>
      <button
        type="button"
        onClick={onShowAll}
        className="rounded-xl border border-borderHover px-4 py-2 text-[12px] font-medium text-text transition hover:bg-white/[0.03]"
      >
        Show all markets
      </button>
    </div>
  );
}

function NotDeployed() {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center rounded-2xl border border-border bg-bgCard p-12 text-center">
      <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-white/[0.03] px-3 py-1">
        <span className="size-[5px] rounded-full bg-warning" />
        <span className="text-[10px] font-medium uppercase tracking-[2px] text-textSec">
          Pre-launch · Audit gate
        </span>
      </div>

      <h2 className="mb-3 text-[28px] font-light tracking-[-0.5px]">
        No markets <span className="font-serif italic">live</span> yet
      </h2>

      <p className="mb-7 max-w-[460px] text-sm font-light leading-relaxed text-textSec">
        The protocol is code-complete and through two internal audit passes (
        <span className="font-mono text-text">0 H/M findings</span>), but mainnet deployment is
        gated on the external audit pipeline (HashEx → ChainSecurity → Code4rena → Immunefi).
        Once Safe + Timelock are provisioned and the factory is deployed, markets land here.
      </p>

      <div className="mb-6 flex items-center gap-3">
        <a
          href="https://github.com/penguinpecker/fission-protocol-hedera"
          target="_blank"
          rel="noreferrer"
          className="rounded-xl border border-borderHover px-5 py-2.5 text-[13px] font-medium text-text transition hover:bg-white/[0.03]"
        >
          View source
        </a>
        <a
          href="https://github.com/penguinpecker/fission-protocol-hedera/tree/main/audits/internal"
          target="_blank"
          rel="noreferrer"
          className="rounded-xl border border-borderHover px-5 py-2.5 text-[13px] font-medium text-textSec transition hover:bg-white/[0.03]"
        >
          Audit reports
        </a>
      </div>

      <p className="font-mono text-[10px] text-textDim">
        v1 lineup: HBARX (Stader) · SaucerSwap V2 LP (WHBAR/USDC, Pendle-Kyber)
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-border bg-bgCard p-10 text-center">
      <div className="mb-2 text-base font-semibold">Factory deployed — no markets created yet</div>
      <p className="max-w-[460px] text-sm text-textSec">
        Markets enter via the 7-day SY whitelist:&nbsp;
        <span className="font-mono text-textSec">proposeSY</span> →&nbsp;wait 7d →&nbsp;
        <span className="font-mono text-textSec">confirmSY</span> →&nbsp;
        <span className="font-mono text-textSec">createMarket</span> →&nbsp;
        <span className="font-mono text-textSec">initialize</span>.
      </p>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-3">
      {[0, 1].map((i) => (
        <div key={i} className="h-[148px] animate-pulse rounded-2xl border border-border bg-bgCard" />
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────── row builders */

function buildRowsFromCache(
  cached: readonly import("@/hooks/useCachedMarkets").CachedMarket[],
): MarketRow[] {
  return cached.map((m) => {
    const lastLn = m.last_ln_implied_rate ? BigInt(m.last_ln_implied_rate) : 0n;
    const expiryDate = m.expiry ? new Date(m.expiry) : null;
    const daysLeft = expiryDate
      ? Math.max(0, Math.floor((expiryDate.getTime() - Date.now()) / 86_400_000))
      : 0;
    return {
      address: m.market_address,
      syAddress: m.sy_address,
      syName: undefined,
      syDecimals: 18,
      symbol: m.market_type === "rewards" ? "fLP-rwd" : "fLP",
      totalSy: m.total_sy_shares ? BigInt(m.total_sy_shares) : 0n,
      totalPt: m.total_pt ? BigInt(m.total_pt) : 0n,
      lpSupply: m.lp_total_supply ? BigInt(m.lp_total_supply) : 0n,
      impliedApy: impliedApyPct(lastLn),
      daysLeft,
      expiryDate: expiryDate
        ? expiryDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "—",
    };
  });
}

function buildMarketRows(
  addresses: readonly `0x${string}`[] | undefined,
  detailsRaw: readonly unknown[] | undefined,
  syMetaRaw: readonly unknown[] | undefined,
  lpMetaRaw: readonly unknown[] | undefined,
): MarketRow[] {
  if (!addresses || !detailsRaw) return [];

  const rows: MarketRow[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const base = i * 6;
    const syAddr = detailsRaw[base] as `0x${string}` | undefined;
    const expiry = detailsRaw[base + 2] as bigint;
    const totalSy = detailsRaw[base + 3] as bigint;
    const totalPt = detailsRaw[base + 4] as bigint;
    const lastLn = detailsRaw[base + 5] as bigint;

    const lpBase = i * 3;
    const symbol = lpMetaRaw ? (lpMetaRaw[lpBase + 1] as string) : "fLP";
    const lpSupply = lpMetaRaw ? (lpMetaRaw[lpBase + 2] as bigint) : 0n;

    const syDecimals = syMetaRaw ? Number(syMetaRaw[i * 2 + 1]) : 18;

    const addr = addresses[i];
    if (!addr) continue;
    rows.push({
      address: addr,
      syAddress: syAddr,
      syName: undefined,
      syDecimals,
      symbol,
      totalSy,
      totalPt,
      lpSupply,
      impliedApy: impliedApyPct(lastLn),
      daysLeft: daysUntil(expiry),
      expiryDate: new Date(Number(expiry) * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    });
  }
  return rows;
}
