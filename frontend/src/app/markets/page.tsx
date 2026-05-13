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
import { getMarketDisplay } from "@/lib/markets-metadata";

const factoryDeployed = isDeployed(ADDRESSES.factory);

export default function MarketsPage() {
  const chainId = useChainId();

  // Fast path: read pre-indexed market state from /api/markets. Falls back to
  // on-chain reads via wagmi when the cache is empty or hasn't been populated
  // yet (first deploy, or before the indexer cron runs).
  const { markets: cached, loading: cachedLoading } = useCachedMarkets();
  const useChainFallback = !cachedLoading && (cached === null || cached.length === 0);

  const { data: countRaw } = useMarketCount();
  const count = countRaw as bigint | undefined;

  const { data: addressesRaw } = useMarketAddresses(useChainFallback ? count : undefined);
  const addresses = addressesRaw as readonly `0x${string}`[] | undefined;

  // Post-HTS-migration: 6 market reads (sy, lp, expiry, totalSy, totalPt, lastLn).
  // Then a second pass reads LP name/symbol/totalSupply via ERC-20 facade and
  // SY shareToken/decimals.
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
      <section className="mx-auto max-w-[1100px] px-6 py-10">
        <header className="mb-10 flex items-end justify-between gap-6">
          <div>
            <h1 className="text-[32px] font-light tracking-[-1px]">
              Yield <span className="font-serif italic">markets</span>
            </h1>
            <p className="mt-2 text-sm font-light text-textDim">
              Split yield-bearing Hedera DeFi tokens into tradeable Principal and Yield components.
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
              {showWatchedOnly ? "All markets" : `My watchlist (${items.length})`}
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
            {markets.map((m) => {
              const meta = getMarketDisplay(m.address);
              const label = meta?.displayName ?? m.syName ?? m.symbol;
              // Fixed APY ≡ Implied APY when buying PT at the current AMM
              // mark. We label it "Fixed" on the list because that's the
              // headline number a user is comparing across markets.
              return (
                <article
                  key={m.address}
                  className="group relative overflow-hidden rounded-2xl border border-border bg-bgCard transition hover:border-borderHover hover:bg-white/[0.02]"
                >
                  <div
                    aria-hidden
                    className="pointer-events-none absolute -right-32 -top-32 size-64 rounded-full bg-[radial-gradient(circle,rgba(125,211,252,0.08),transparent_70%)] opacity-0 transition group-hover:opacity-100"
                  />
                  <Link
                    href={`/markets/${m.address}`}
                    className="absolute inset-0 z-10 rounded-2xl"
                    aria-label={`View ${label}`}
                  />
                  <div className="pointer-events-none relative z-20 grid grid-cols-[auto_2.4fr_1fr_1fr_1fr] items-center gap-4 px-6 py-5">
                    <div className="pointer-events-auto">
                      <StarButton
                        watched={isWatched(chainId, m.address)}
                        signedIn={signedIn}
                        onClick={() => toggle(chainId, m.address)}
                      />
                    </div>
                    <div className="pointer-events-none">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-semibold tracking-tight">{label}</span>
                        {meta?.assets.map((a) => (
                          <span
                            key={a}
                            className="rounded-full border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1px] text-textSec"
                          >
                            {a}
                          </span>
                        ))}
                        {meta && (
                          <span className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1.5px] text-textDim">
                            {meta.protocol}
                            {meta.poolFeePct !== undefined && ` · ${meta.poolFeePct}%`}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 text-[12px] text-textSec">
                        {meta?.yieldSource ?? "Tokenized yield"}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-textDim">
                        <span className={m.daysLeft <= 7 ? "text-warning" : ""}>
                          {m.daysLeft}d to maturity
                        </span>
                        <span className="text-border">·</span>
                        <span>{m.expiryDate}</span>
                      </div>
                    </div>
                    <div className="pointer-events-none">
                      <Stat label="Fixed APY" value={`${m.impliedApy.toFixed(2)}%`} accent="white" />
                    </div>
                    <div className="pointer-events-none">
                      <Stat label="SY locked" value={formatCompact(m.totalSy)} accent="silver" />
                    </div>
                    <div className="pointer-events-none">
                      <Stat label="Liquidity" value={formatCompact(m.lpSupply)} accent="silver" />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      </WalletGate>
      <Footer />
    </main>
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
      className={`relative z-10 -ml-1 grid size-8 place-items-center rounded-lg transition ${
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

function Stat({ label, value, accent }: { label: string; value: string; accent: "white" | "silver" }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-[1px] text-textDim">{label}</div>
      <div
        className={`font-mono text-[18px] font-bold tracking-tight ${
          accent === "white" ? "text-text" : "text-silver"
        }`}
      >
        {value}
      </div>
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
    <div className="space-y-2">
      {[0, 1].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-2xl border border-border bg-bgCard" />
      ))}
    </div>
  );
}

interface MarketRow {
  address: `0x${string}`;
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

function buildRowsFromCache(cached: readonly import("@/hooks/useCachedMarkets").CachedMarket[]): MarketRow[] {
  return cached.map((m) => {
    const lastLn = m.last_ln_implied_rate ? BigInt(m.last_ln_implied_rate) : 0n;
    const expiryDate = m.expiry ? new Date(m.expiry) : null;
    const daysLeft = expiryDate
      ? Math.max(0, Math.floor((expiryDate.getTime() - Date.now()) / 86_400_000))
      : 0;
    return {
      address: m.market_address,
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
    // Market read offsets — see useMarketDetails (6 fields per market):
    //   [0] sy, [1] lp, [2] expiry, [3] totalSy, [4] totalPt, [5] lastLnImpliedRate.
    const base = i * 6;
    const expiry = detailsRaw[base + 2] as bigint;
    const totalSy = detailsRaw[base + 3] as bigint;
    const totalPt = detailsRaw[base + 4] as bigint;
    const lastLn = detailsRaw[base + 5] as bigint;

    // LP metadata reads (3 per LP via ERC-20 facade): name, symbol, totalSupply.
    const lpBase = i * 3;
    const symbol = lpMetaRaw ? (lpMetaRaw[lpBase + 1] as string) : "fLP";
    const lpSupply = lpMetaRaw ? (lpMetaRaw[lpBase + 2] as bigint) : 0n;

    // SY meta: [shareTokenAddr, decimals]. SY name reads come from the share token's
    // ERC-20 facade — for the markets list we don't need the name, just decimals.
    const syDecimals = syMetaRaw ? Number(syMetaRaw[i * 2 + 1]) : 18;

    const addr = addresses[i];
    if (!addr) continue;
    rows.push({
      address: addr,
      syName: undefined, // omitted at list-level; show on detail page via shareToken.name()
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
