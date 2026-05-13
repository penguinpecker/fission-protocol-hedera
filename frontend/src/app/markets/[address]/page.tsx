"use client";

/**
 * Market overview page — Phase 7 redesign: strategy cards are the focal point.
 *
 * The page is intentionally minimal:
 *   - Breadcrumb (Markets / <name>)
 *   - Title + maturity strip (the market's context, not a position)
 *   - StrategyOverview (the 3 cards: PT, YT, LP)
 *   - "Need SY first?" inline link → `/markets/[addr]/pt` (the PT and YT
 *      sub-pages now auto-mint SY from HBAR inline via the source toggle, so
 *      there's no standalone /mint route anymore; PT is the most common
 *      destination so we send the "no SY yet" pointer there)
 *
 * The user's position summary, the inline mint collapsible, and post-expiry
 * redeem block all moved off this page so the 3 strategy cards stand alone as
 * the entry into the trade UI. Position state lives on `/profile`; redeem
 * lives on `/markets/[addr]/pt` and `/yt` (sub-pages already gate on expiry).
 */

import Link from "next/link";
import { use, useEffect } from "react";
import { Nav } from "@/components/Nav";
import { diag } from "@/lib/diag";
import { Footer } from "@/components/Footer";
import { WalletGate } from "@/components/WalletGate";
import { useMarketDetail } from "@/hooks/useMarket";
import { StrategyOverview } from "@/components/StrategyOverview";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { daysUntil } from "@/hooks/useMarkets";

export default function MarketDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: marketAddrParam } = use(params);
  const market = marketAddrParam as `0x${string}`;
  const { data: detail, isLoading } = useMarketDetail(market);
  const adapter = useWalletAdapter();
  const user = adapter.address ?? undefined;

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
  const days = daysUntil(detail.expiry);

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

          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-[28px] font-semibold tracking-tight">{detail.syName}</h1>
              <div className="mt-1 text-sm text-textDim">
                Matures{" "}
                {new Date(Number(detail.expiry) * 1000).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}{" "}
                · {days} days left
                {expired && (
                  <span className="ml-2 rounded bg-error/10 px-2 py-0.5 text-[10px] font-semibold text-error">
                    EXPIRED
                  </span>
                )}
              </div>
            </div>

            {/* "Need SY?" inline pointer. The PT sub-page now auto-mints SY
                from HBAR via the source toggle, so the standalone /mint
                concept retired in favour of an inline chained flow there. */}
            <Link
              href={`/markets/${market}/pt`}
              className="rounded-xl border border-border bg-white/[0.02] px-4 py-2 text-[12px] font-medium text-textSec transition hover:border-borderHover hover:bg-white/[0.04] hover:text-text"
            >
              Need SY? <span className="ml-1 text-textDim">Mint from HBAR →</span>
            </Link>
          </div>

          <StrategyOverview detail={detail} market={market} />
        </div>
      </WalletGate>
      <Footer />
    </main>
  );
}
