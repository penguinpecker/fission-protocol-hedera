"use client";

import Link from "next/link";
import { Nav } from "@/components/Nav";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import {
  useMarketCount,
  useMarketAddresses,
  useMarketDetails,
  useLpMetadata,
  useSyMetadata,
  impliedApyPct,
  daysUntil,
  formatBigInt,
} from "@/hooks/useMarkets";

const factoryDeployed = isDeployed(ADDRESSES.factory);

export default function MarketsPage() {
  const { data: countRaw } = useMarketCount();
  const count = countRaw as bigint | undefined;

  const { data: addressesRaw } = useMarketAddresses(count);
  const addresses = addressesRaw as readonly `0x${string}`[] | undefined;

  // Post-HTS-migration: 6 market reads (sy, lp, expiry, totalSy, totalPt, lastLn).
  // Then a second pass reads LP name/symbol/totalSupply via ERC-20 facade and
  // SY shareToken/decimals.
  const { data: detailsRaw, isLoading: detailsLoading } = useMarketDetails(addresses);
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

  const markets = buildMarketRows(addresses, detailsRaw, syMetaRaw, lpMetaRaw);

  return (
    <main className="min-h-screen">
      <Nav />

      <section className="mx-auto max-w-[1100px] px-6 py-10">
        <header className="mb-10">
          <h1 className="text-[32px] font-light tracking-[-1px]">
            Yield <span className="font-serif italic">markets</span>
          </h1>
          <p className="mt-2 text-sm font-light text-textDim">
            Split yield-bearing Hedera DeFi tokens into tradeable Principal and Yield components.
          </p>
        </header>

        {!factoryDeployed && <NotDeployed />}

        {factoryDeployed && count === 0n && <EmptyState />}

        {factoryDeployed && detailsLoading && <Loading />}

        {markets.length > 0 && (
          <div className="flex flex-col gap-2">
            {markets.map((m) => (
              <Link
                key={m.address}
                href={`/markets/${m.address}`}
                className="grid grid-cols-[2.2fr_1fr_1fr_1fr_1fr] items-center gap-4 rounded-2xl border border-border bg-bgCard px-6 py-5 transition hover:border-borderHover hover:bg-white/[0.02]"
              >
                <div>
                  <div className="text-[15px] font-semibold">{m.syName ?? m.symbol}</div>
                  <div className="text-xs text-textDim">
                    {m.daysLeft}d to maturity · {m.expiryDate}
                  </div>
                </div>
                <Stat label="Implied APY" value={`${m.impliedApy.toFixed(2)}%`} accent="white" />
                <Stat
                  label="SY locked"
                  value={`${formatBigInt(m.totalSy, m.syDecimals, 2)}`}
                  accent="silver"
                />
                <Stat
                  label="PT in pool"
                  value={`${formatBigInt(m.totalPt, m.syDecimals, 2)}`}
                  accent="silver"
                />
                <Stat
                  label="LP supply"
                  value={`${formatBigInt(m.lpSupply, 18, 2)}`}
                  accent="silver"
                />
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
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
