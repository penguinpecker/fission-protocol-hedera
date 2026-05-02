"use client";

import Link from "next/link";
import { Nav } from "@/components/Nav";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import {
  useMarketCount,
  useMarketAddresses,
  useMarketDetails,
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

  const { data: detailsRaw, isLoading: detailsLoading } = useMarketDetails(addresses);
  const syAddrs =
    addresses && detailsRaw
      ? addresses.map((_, i) => detailsRaw[i * 8] as `0x${string}`)
      : undefined;
  const { data: syMetaRaw } = useSyMetadata(syAddrs);

  const markets = buildMarketRows(addresses, detailsRaw, syMetaRaw);

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
    <div className="rounded-2xl border border-border bg-bgCard p-10 text-center">
      <div className="mb-2 text-base font-semibold">Factory not yet deployed</div>
      <p className="mb-4 text-sm text-textSec">
        Set <code className="font-mono text-xs text-text">NEXT_PUBLIC_FACTORY_ADDRESS</code> at build time
        to point at a live FissionFactory deployment. Mainnet deployment is gated on the audit
        pipeline (Phase 9).
      </p>
      <a
        href="https://github.com/penguinpecker/fission-protocol-hedera/blob/main/docs/IMPLEMENTATION_PLAN.md"
        target="_blank"
        rel="noreferrer"
        className="text-xs text-textSec underline-offset-4 hover:text-text hover:underline"
      >
        Roadmap
      </a>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-border bg-bgCard p-10 text-center">
      <div className="text-sm text-textSec">No markets created yet — proposeSY → 7-day review → confirmSY → createMarket.</div>
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
): MarketRow[] {
  if (!addresses || !detailsRaw) return [];

  const rows: MarketRow[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const base = i * 8;
    const expiry = detailsRaw[base + 1] as bigint;
    const totalSy = detailsRaw[base + 2] as bigint;
    const totalPt = detailsRaw[base + 3] as bigint;
    const lastLn = detailsRaw[base + 4] as bigint;
    const lpSupply = detailsRaw[base + 5] as bigint;
    const symbol = detailsRaw[base + 7] as string;

    const syName = syMetaRaw ? (syMetaRaw[i * 2] as string) : undefined;
    const syDecimals = syMetaRaw ? Number(syMetaRaw[i * 2 + 1]) : 18;

    const addr = addresses[i];
    if (!addr) continue;
    rows.push({
      address: addr,
      syName,
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
