"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChainId } from "wagmi";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
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
import { useSyValueUsd, useHbarUsd, formatUsd } from "@/hooks/useSyValueUsd";
import { getMarketDisplay } from "@/lib/markets-metadata";

const factoryDeployed = isDeployed(ADDRESSES.factory);

/**
 * Terminal-style markets page. Two-column layout:
 *
 *   left  → breadcrumb + headline + tools row + market table + footer line
 *   right → three stacked sidebar panels (protocol_stats / network / governance)
 *
 * Each table row is clickable and routes to `/markets/{address}`. TVL per row
 * uses the per-market `useSyValueUsd` hook (Uniswap-V3 LP basket valuation).
 * Volume 24h has no indexer yet — surfaced as `$—`. Block height comes from
 * Hedera Mirror Node; HBAR price from CoinGecko via `useHbarUsd`.
 */
export default function MarketsPage() {
  // Markets list is public — TVL, APY, expiry are on-chain reads usable
  // without a wallet. The per-market trade pages keep their own gates where
  // signing is required.
  return (
    <main className="min-h-screen text-text">
      <Nav />
      <MarketsBody />
      <Footer />
    </main>
  );
}

function MarketsBody() {
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

  const { isWatched, toggle, signedIn } = useWatchlist();
  const [filter, setFilter] = useState<"all" | "active" | "expired" | "rewards">("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allMarkets.filter((m) => {
      if (filter === "active" && m.expired) return false;
      if (filter === "expired" && !m.expired) return false;
      if (filter === "rewards" && !m.isRewards) return false;
      if (!q) return true;
      const label = getMarketDisplay(m.address)?.displayName ?? m.symbol;
      const underlying = (getMarketDisplay(m.address)?.assets ?? []).join("/");
      return (
        label.toLowerCase().includes(q) ||
        underlying.toLowerCase().includes(q) ||
        m.address.toLowerCase().includes(q)
      );
    });
  }, [allMarkets, query, filter]);

  const activeCount = allMarkets.filter((m) => !m.expired).length;

  return (
    <div className="mx-auto grid max-w-[1440px] gap-8 px-4 py-8 sm:px-6 sm:py-12 md:px-7 lg:grid-cols-[1fr_320px]">
      {/* ─── Left column ───────────────────────────────────────────── */}
      <div className="min-w-0">
        <header className="mb-7 flex flex-wrap items-end justify-between gap-4 sm:gap-6">
          <div className="term-fade">
            <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-textDim">
              // MARKETS
            </div>
            <h1 className="mt-2 text-[28px] font-semibold leading-[1.05] tracking-[-0.02em] text-white sm:text-[38px]">
              Yield <span className="font-serif italic">markets</span>
            </h1>
            <p className="mt-1.5 max-w-[640px] font-mono text-[13px] text-textSec sm:text-[13.5px]">
              Each market splits a SaucerSwap V2 position into PT, YT, and LP tokens with a fixed maturity.
            </p>
          </div>

          <div className="term-fade term-fade-d1 flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <SearchInput value={query} onChange={setQuery} />
            <div className="flex flex-wrap gap-1">
              {(["all", "active", "expired", "rewards"] as const).map((f) => (
                <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                </Chip>
              ))}
            </div>
          </div>
        </header>

        {!factoryDeployed && <NotDeployed />}

        {factoryDeployed && useChainFallback && count === 0n && <EmptyState />}

        {factoryDeployed && (cachedLoading || (useChainFallback && detailsLoading)) && <Loading />}

        {filtered.length > 0 && (
          <div className="term-fade term-fade-d2 overflow-x-auto border border-border bg-white/[0.015]">
            <table className="w-full min-w-[760px] border-collapse">
              <thead className="bg-white/[0.04]">
                <tr>
                  <Th>Market</Th>
                  <Th>Underlying</Th>
                  <Th align="right">Maturity</Th>
                  <Th align="right">Implied APY</Th>
                  <Th align="right">Liquidity</Th>
                  <Th align="right">PT Price</Th>
                  <Th align="right">Vol 24h</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <MarketRow
                    key={m.address}
                    row={m}
                    starred={isWatched(chainId, m.address)}
                    signedIn={signedIn}
                    onStar={() => toggle(chainId, m.address)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-5 font-mono text-[12.5px] tracking-[0.06em] text-textDim">
          Showing {filtered.length} market{filtered.length === 1 ? "" : "s"} · {activeCount} active ·
          last block synced ~30s ago
        </div>
      </div>

      {/* ─── Right sidebar ─────────────────────────────────────────── */}
      <aside className="term-fade term-fade-d3 flex flex-col gap-6">
        <ProtocolStatsCard markets={allMarkets} />
      </aside>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── table row */

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
  expired: boolean;
  isRewards: boolean;
}

function MarketRow({
  row,
  starred,
  signedIn,
  onStar,
}: {
  row: MarketRow;
  starred: boolean;
  signedIn: boolean;
  onStar: () => void;
}) {
  const meta = getMarketDisplay(row.address);
  const symbol = meta?.shortName ?? row.symbol;
  const underlying = meta?.assets.length
    ? `${meta.assets.join(" / ")}${meta.protocol ? " LP" : ""}`
    : "—";

  // SY USD valuation. For HBARX-style adapters this resolves to undefined and
  // we just fall back to the SY-share count formatted compactly.
  const { usdPerShare } = useSyValueUsd(row.syAddress);
  const tvlUsd =
    usdPerShare !== undefined && row.totalSy > 0n
      ? Number(row.totalSy) * usdPerShare
      : undefined;
  const tvlDisplay = formatUsd(tvlUsd) ?? formatCompact(row.totalSy);

  // PT price in SY units: discounted simple-interest model lined up with
  // MarketPositionCard.ptToSyRate.
  const ptInSy =
    row.daysLeft > 0
      ? 1 / (1 + (row.impliedApy / 100) * (row.daysLeft / 365))
      : 1;

  const subLabel = row.isRewards ? "Market 0 · Rewards" : meta?.protocol ?? row.symbol;
  const router = useRouter();
  const href = `/markets/${row.address}`;

  // Whole-row click → navigate. Previously only the first two Tds wrapped
  // their content in <Link>; the other 6 cells (maturity / APY / TVL / PT
  // price / 24h / status) were inert. onClick on <tr> makes the entire
  // surface a click target; the star button uses stopPropagation so it
  // still toggles the watchlist instead of routing.
  return (
    <tr
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(href);
        }
      }}
      aria-label={`Open ${symbol}`}
      className="group cursor-pointer border-b border-border last:border-b-0 transition hover:bg-white/[0.04] focus:bg-white/[0.04] focus:outline-none"
    >
      <Td>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onStar();
            }}
            disabled={!signedIn}
            title={
              signedIn
                ? starred
                  ? "Remove from watchlist"
                  : "Add to watchlist"
                : "Sign in to use watchlist"
            }
            className={`-ml-1 grid size-6 place-items-center transition ${
              signedIn
                ? starred
                  ? "text-white"
                  : "text-textDim hover:text-white"
                : "cursor-not-allowed opacity-30"
            }`}
            aria-pressed={starred}
          >
            {starred ? "★" : "☆"}
          </button>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[13px] font-medium tracking-[0.02em] text-white">
              {symbol}
            </span>
            <span className="font-mono text-[11px] text-textDim">{subLabel}</span>
          </div>
        </div>
      </Td>
      <Td>
        <span className="font-mono text-[13px] text-text">{underlying}</span>
      </Td>
      <NumTd dim={row.expired}>{row.expired ? "—" : `${row.daysLeft}d · ${row.expiryDate}`}</NumTd>
      <NumTd accent>{row.expired ? "—" : `${row.impliedApy.toFixed(2)}%`}</NumTd>
      <NumTd>{tvlDisplay}</NumTd>
      <NumTd dim={row.expired}>{row.expired ? "—" : `${ptInSy.toFixed(4)} SY`}</NumTd>
      <NumTd dim>$—</NumTd>
      <Td>
        {row.expired ? (
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-textDim">
            expired
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-textSec">
            <span className="term-pulse-dot inline-block size-[5px] rounded-full bg-white" />
            LIVE
          </span>
        )}
      </Td>
    </tr>
  );
}

/* ─────────────────────────────────────────────────────── sidebar cards */

function ProtocolStatsCard({ markets }: { markets: MarketRow[] }) {
  return (
    <SidePanel>
      <SideCard title="// protocol_stats">
        <ProtocolStatsRows markets={markets} />
      </SideCard>
      <SideCard title="// network">
        <NetworkRows />
      </SideCard>
      <SideCard title="// governance">
        <SideRow k="Admin" v="Timelock" />
        <SideRow k="Delay" v="48 hours" />
        <SideRow k="Threshold" v="2-of-2" />
        <SideRow k="Pending ops" v="0" />
      </SideCard>
    </SidePanel>
  );
}

function ProtocolStatsRows({ markets }: { markets: MarketRow[] }) {
  // Per-market TVL aggregation. We need each row's `useSyValueUsd` hook to
  // run at a stable call site, so the summing component dispatches one tiny
  // child per market that reports its USD value up. This sidesteps the
  // hooks-in-loops rule while keeping the parent re-renders cheap.
  const [tvlByMarket, setTvlByMarket] = useState<Record<string, number | undefined>>({});

  // Reset when the market list changes (post-cache refresh).
  useEffect(() => {
    setTvlByMarket({});
  }, [markets.length]);

  // Stable handler — passing an inline arrow here makes every TvlReporter's
  // effect refire each render. Profile page hit the same trap and locked the
  // main thread, blocking header clicks.
  const handleTvlReport = useCallback((address: string, usd: number | undefined) => {
    setTvlByMarket((prev) => {
      if (prev[address] === usd) return prev;
      return { ...prev, [address]: usd };
    });
  }, []);

  const totalSyShares = markets.reduce((acc, m) => acc + m.totalSy, 0n);
  const totalPt = markets.reduce((acc, m) => acc + m.totalPt, 0n);
  const totalLp = markets.reduce((acc, m) => acc + m.lpSupply, 0n);

  const tvlSum = Object.values(tvlByMarket).reduce<number | undefined>(
    (acc, v) => (acc === undefined ? v : v === undefined ? acc : acc + v),
    undefined,
  );

  return (
    <>
      <SideRow k="Total TVL" v={tvlSum !== undefined ? (formatUsd(tvlSum) ?? "$—") : "$—"} />
      <SideRow k="Markets active" v={String(markets.filter((m) => !m.expired).length)} />
      <SideRow k="Total PT supply" v={formatCompact(totalPt)} />
      <SideRow k="Total YT supply" v={formatCompact(totalPt) /* PT == YT supply by construction */} />
      <SideRow k="Total LP supply" v={formatCompact(totalLp)} />
      <SideRow k="Total SY shares" v={formatCompact(totalSyShares)} />
      <SideRow k="Treasury balance" v="$0.00" />

      {markets.map((m) => (
        <TvlReporter
          key={m.address}
          marketAddress={m.address}
          syAddress={m.syAddress}
          totalSy={m.totalSy}
          onReport={handleTvlReport}
        />
      ))}
    </>
  );
}

/**
 * Headless per-market TVL probe. Runs `useSyValueUsd` for one address and
 * pushes the resulting USD figure up via callback. Rendered as a sibling of
 * the table so the hook call site is stable.
 */
function TvlReporter({
  marketAddress,
  syAddress,
  totalSy,
  onReport,
}: {
  marketAddress: `0x${string}`;
  syAddress: `0x${string}` | undefined;
  totalSy: bigint;
  onReport: (marketAddress: string, usd: number | undefined) => void;
}) {
  const { usdPerShare } = useSyValueUsd(syAddress);
  useEffect(() => {
    const tvl =
      usdPerShare !== undefined && totalSy > 0n ? Number(totalSy) * usdPerShare : undefined;
    onReport(marketAddress, tvl);
  }, [marketAddress, usdPerShare, totalSy, onReport]);
  return null;
}

function NetworkRows() {
  const hbarUsd = useHbarUsd();
  const [block, setBlock] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          "https://mainnet-public.mirrornode.hedera.com/api/v1/blocks?limit=1&order=desc",
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const j = (await r.json()) as { blocks: Array<{ number: number }> };
        const n = j.blocks?.[0]?.number;
        if (!cancelled && typeof n === "number") {
          setBlock(n.toLocaleString("en-US"));
        }
      } catch {
        /* swallow — non-critical */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <SideRow k="Chain" v="Hedera · 295" />
      <SideRow k="Block" v={block ?? "—"} />
      <SideRow k="Gas (HBAR)" v="$0.0001" />
      <SideRow
        k="HBAR price"
        v={hbarUsd !== undefined ? `$${hbarUsd.toFixed(4)}` : "—"}
      />
    </>
  );
}

/* ─────────────────────────────────────────────────────── primitives */

function SidePanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-px border border-border bg-border">{children}</div>
  );
}

function SideCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/[0.015] p-5">
      <h4 className="mb-3.5 font-mono text-[10.5px] uppercase tracking-[0.2em] text-textDim">
        {title}
      </h4>
      {children}
    </div>
  );
}

function SideRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-border py-1.5 font-mono text-[12.5px] last:border-b-0">
      <span className="text-textDim">{k}</span>
      <span className="text-white tabular-nums">{v}</span>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      className={`whitespace-nowrap border-b border-border px-3 py-3.5 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-textDim sm:px-[18px] ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="border-b border-border px-3 py-[14px] font-mono text-[13px] text-text last:border-b-0 sm:px-[18px] sm:py-[18px] sm:text-[13.5px]">
      {children}
    </td>
  );
}

function NumTd({
  children,
  accent,
  dim,
}: {
  children: React.ReactNode;
  accent?: boolean;
  dim?: boolean;
}) {
  return (
    <td
      className={`whitespace-nowrap border-b border-border px-3 py-[14px] text-right font-mono text-[13px] tabular-nums last:border-b-0 sm:px-[18px] sm:py-[18px] sm:text-[13.5px] ${
        dim ? "text-textDim" : accent ? "font-medium text-white" : "text-white"
      }`}
    >
      {children}
    </td>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex w-full items-center gap-2 border border-borderHover bg-white/[0.015] px-3 py-2 sm:w-[260px]">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-textDim"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="search by symbol or underlying"
        className="flex-1 bg-transparent font-mono text-[12.5px] text-text outline-none placeholder:text-textDim"
      />
    </label>
  );
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition ${
        active
          ? "border-white bg-white text-black"
          : "border-borderHover bg-white/[0.015] text-textSec hover:border-white/15 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────────────────────────────── empty states */

function NotDeployed() {
  return (
    <div className="border border-border bg-white/[0.015] p-10 text-center">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-warning">
        // pre-launch · audit gate
      </div>
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-white">
        No markets <span className="font-serif italic">live</span> yet
      </h2>
      <p className="mx-auto mt-3 max-w-[460px] font-mono text-[13px] leading-relaxed text-textSec">
        The protocol is code-complete and through two internal audit passes. Mainnet
        deployment is gated on the external audit pipeline.
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="border border-border bg-white/[0.015] p-10 text-center">
      <div className="font-semibold text-white">Factory deployed — no markets created yet</div>
      <p className="mx-auto mt-2 max-w-[460px] font-mono text-[12.5px] text-textSec">
        Markets enter via the 7-day SY whitelist: proposeSY → wait 7d → confirmSY → createMarket → initialize.
      </p>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-[58px] animate-pulse border border-border bg-white/[0.015]" />
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
    const expired = expiryDate ? expiryDate.getTime() <= Date.now() : false;
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
        ? expiryDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "—",
      expired,
      isRewards: m.market_type === "rewards",
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
    const expirySec = Number(expiry);
    const expired = expirySec * 1000 <= Date.now();
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
      expiryDate: new Date(expirySec * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      expired,
      isRewards: symbol.toLowerCase().includes("rwd"),
    });
  }
  return rows;
}
