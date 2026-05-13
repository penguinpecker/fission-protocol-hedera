"use client";

/**
 * Market overview page — the entry point for a single market. After Phase 3
 * this page is overview-only: the heavy trade UI lives on the three
 * sub-routes (/pt, /yt, /lp).
 *
 * Layout (top-down):
 *   Breadcrumb
 *   Title + matures-in row
 *   Stats row (5 cells)
 *   MarketPositionCard
 *   Collapsible "Need SY first?" mint form
 *   StrategyOverview (3 cards linking to sub-pages)
 *   PostExpiryActions (only when expired with PT/YT balance)
 */

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { Nav } from "@/components/Nav";
import { diag } from "@/lib/diag";
import { Footer } from "@/components/Footer";
import { WalletGate } from "@/components/WalletGate";
import { useMarketDetail, useUserPosition } from "@/hooks/useMarket";
import { useSyValueUsd } from "@/hooks/useSyValueUsd";
import { MarketPositionCard } from "@/components/MarketPositionCard";
import { StrategyOverview } from "@/components/StrategyOverview";
import { MintSyForm } from "@/components/forms/MintSyForm";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { impliedApyPct, daysUntil, formatBigInt, formatCompact } from "@/hooks/useMarkets";

export default function MarketDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: marketAddrParam } = use(params);
  const market = marketAddrParam as `0x${string}`;
  const { data: detail, isLoading } = useMarketDetail(market);
  const adapter = useWalletAdapter();
  const user = adapter.address ?? undefined;
  const { data: position } = useUserPosition(market, detail, user);
  const showUsdHint = adapter.mode !== "evm";
  const { usdPerShare } = useSyValueUsd(showUsdHint ? detail?.sy : undefined);

  const [mintOpen, setMintOpen] = useState(false);

  const ptPriceApy = useMemo(() => {
    if (!detail) return null;
    return impliedApyPct(detail.lastLnImpliedRate);
  }, [detail]);

  useEffect(() => {
    diag("MarketDetailPage", {
      market,
      user,
      isLoading,
      detailLoaded: !!detail,
      syName: detail?.syName,
      totalSyZero: detail ? detail.totalSy === 0n : null,
    });
  }, [market, user, isLoading, detail]);

  if (isLoading || !detail) {
    return (
      <main className="min-h-screen">
        <Nav />
        <WalletGate>
          <div className="mx-auto max-w-[1100px] px-6 py-10">
            <div className="h-32 animate-pulse rounded-2xl border border-border bg-bgCard" />
          </div>
        </WalletGate>
        <Footer />
      </main>
    );
  }

  const expired = Date.now() / 1000 >= Number(detail.expiry);
  const userHasSy = (position?.sy ?? 0n) > 0n;

  return (
    <main className="min-h-screen">
      <Nav />

      <WalletGate>
        <div className="mx-auto max-w-[1100px] px-6 py-7">
          <div className="mb-7 flex items-center gap-2 text-[13px] text-textSec">
            <Link href="/markets" className="hover:text-text">
              Markets
            </Link>
            <span className="text-textDim">/</span>
            <span className="text-text">{detail.syName}</span>
          </div>

          <div className="mb-6">
            <h1 className="text-[26px] font-semibold tracking-tight">{detail.syName}</h1>
            <div className="mt-1 text-sm text-textDim">
              Matures{" "}
              {new Date(Number(detail.expiry) * 1000).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}{" "}
              · {daysUntil(detail.expiry)} days left
              {expired && (
                <span className="ml-2 rounded bg-error/10 px-2 py-0.5 text-[10px] font-semibold text-error">
                  EXPIRED
                </span>
              )}
            </div>
          </div>

          <div className="mb-3 grid grid-cols-5 gap-px overflow-hidden rounded-2xl bg-border">
            <Stat label="Implied APY" value={ptPriceApy !== null ? `${ptPriceApy.toFixed(2)}%` : "—"} />
            <Stat label="SY locked" value={formatCompact(detail.totalSy)} mono />
            <Stat label="PT in pool" value={formatCompact(detail.totalPt)} mono />
            <Stat label="LP supply" value={formatCompact(detail.lpSupply)} mono />
            <Stat label="SY rate" value={formatBigInt(detail.syExchangeRate, 18, 4)} mono />
          </div>

          {user && (
            <div className="mb-6">
              <MarketPositionCard
                detail={detail}
                position={position}
                usdPerShare={usdPerShare}
                market={market}
              />
            </div>
          )}

          {user && !expired && (
            <div className="mb-6 rounded-2xl border border-border bg-bgCard">
              <button
                type="button"
                onClick={() => setMintOpen((v) => !v)}
                className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-white/[0.02]"
              >
                <div>
                  <div className="text-[13px] font-semibold tracking-tight text-text">
                    {userHasSy ? "Mint more SY" : "Need SY first? Mint some"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-textDim">
                    Convert HBAR (or USDC + WHBAR) into SY shares — SY is the input for every strategy below.
                  </div>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-textDim">
                  {mintOpen ? "Hide" : "Open"}
                </span>
              </button>
              {mintOpen && (
                <div className="border-t border-border p-4">
                  <MintSyForm sy={detail.sy} syShare={detail.syShare} user={user} />
                </div>
              )}
            </div>
          )}

          <StrategyOverview detail={detail} market={market} />

          {expired && user && position && (position.pt > 0n || position.yt > 0n) && (
            <PostExpiryActions market={market} position={position} />
          )}
        </div>
      </WalletGate>
      <Footer />
    </main>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-bgCard px-5 py-4">
      <div className="mb-1 text-[10px] uppercase tracking-[1px] text-textDim">{label}</div>
      <div className={`text-[20px] font-bold tracking-tight text-text ${mono ? "font-mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function PostExpiryActions({
  market,
  position,
}: {
  market: `0x${string}`;
  position: { pt: bigint; yt: bigint };
}) {
  const adapter = useWalletAdapter();
  const user = adapter.address ?? undefined;
  const [isPending, setIsPending] = useState(false);

  const redeem = async () => {
    if (!user) return;
    setIsPending(true);
    try {
      await adapter.write({
        kind: "redeemAfterExpiry",
        market,
        ptIn: position.pt,
        ytIn: position.yt,
        receiver: user,
      });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="mt-6 rounded-2xl border border-error/20 bg-error/5 p-5">
      <div className="mb-2 text-sm font-semibold text-error">Market expired — redeem your PT/YT</div>
      <button
        type="button"
        disabled={isPending}
        onClick={redeem}
        className="rounded-lg bg-white px-5 py-2 text-sm font-semibold text-bg transition hover:opacity-90 disabled:opacity-40"
      >
        {isPending ? "Confirming…" : "Redeem PT + YT"}
      </button>
    </div>
  );
}
