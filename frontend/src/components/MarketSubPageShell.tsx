"use client";

/**
 * Shared shell for /markets/[address]/{pt,yt,lp} sub-pages. Renders the
 * common header, breadcrumb, position card, and 2-column grid; consumers
 * supply the strategy economics (LEFT) and the trade form (RIGHT).
 *
 * Kept lean — page-specific copy lives in each page module so the strategy
 * pages stay self-contained and easy to tweak independently.
 */
import Link from "next/link";
import { use, useEffect, type ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletGate } from "@/components/WalletGate";
import { useMarketDetail, useUserPosition, type MarketDetail } from "@/hooks/useMarket";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { daysUntil } from "@/hooks/useMarkets";
import { diag } from "@/lib/diag";

export interface MarketSubPageProps {
  params: Promise<{ address: string }>;
  /** Crumb label shown after the SY name in the breadcrumb. */
  crumb: string;
  /** Renders the economics column. Receives the loaded MarketDetail. */
  renderEconomics: (detail: MarketDetail) => ReactNode;
  /**
   * Renders the trade form column. Receives the loaded MarketDetail and the
   * user's current SY balance (for `MAX` button + insufficient-balance hints).
   */
  renderTradeForm: (args: {
    detail: MarketDetail;
    user: `0x${string}` | undefined;
    market: `0x${string}`;
    syBalance: bigint;
  }) => ReactNode;
}

export function MarketSubPageShell({
  params,
  crumb,
  renderEconomics,
  renderTradeForm,
}: MarketSubPageProps) {
  const { address: marketAddrParam } = use(params);
  const market = marketAddrParam as `0x${string}`;
  const { data: detail, isLoading } = useMarketDetail(market);
  const adapter = useWalletAdapter();
  const user = adapter.address ?? undefined;
  // Position is fetched only for `syBalance` (used by the trade form's
  // MAX button + insufficient-balance hint). The big PT/YT/LP position
  // card is no longer rendered here — positions live on /profile only.
  const { data: position } = useUserPosition(market, detail, user);

  useEffect(() => {
    diag("MarketSubPage", {
      market,
      crumb,
      user,
      isLoading,
      detailLoaded: !!detail,
    });
  }, [market, crumb, user, isLoading, detail]);

  if (isLoading || !detail) {
    return (
      <main className="min-h-screen">
        <Nav />
        <WalletGate>
          <div className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6 sm:py-10">
            <div className="h-32 animate-pulse rounded-2xl border border-border bg-bgCard" />
          </div>
        </WalletGate>
        <Footer />
      </main>
    );
  }

  const expired = Date.now() / 1000 >= Number(detail.expiry);
  const matures = new Date(Number(detail.expiry) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const syBalance = position?.sy ?? 0n;

  return (
    <main className="min-h-screen">
      <Nav />
      <WalletGate>
        <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6 sm:py-7">
          <div className="mb-6 flex flex-wrap items-center gap-2 text-[13px] text-textSec">
            <Link href="/markets" className="hover:text-text">
              Markets
            </Link>
            <span className="text-textDim">/</span>
            <Link href={`/markets/${market}`} className="break-all hover:text-text">
              {detail.syName}
            </Link>
            <span className="text-textDim">/</span>
            <span className="text-text">{crumb}</span>
          </div>

          <div className="mb-6 min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight sm:text-[26px]">
              <span className="break-words">{detail.syName}</span>{" "}
              <span className="text-textDim">·</span>{" "}
              <span className="text-textSec">{crumb}</span>
            </h1>
            <div className="mt-1 text-sm text-textDim">
              Matures {matures} · {daysUntil(detail.expiry)} days left
              {expired && (
                <span className="ml-2 rounded bg-error/10 px-2 py-0.5 text-[10px] font-semibold text-error">
                  EXPIRED
                </span>
              )}
            </div>
          </div>

          {/* Position card intentionally removed from strategy sub-pages —
              positions live on /profile only. Keeping it here doubled the
              vertical chrome on /pt /yt /lp without adding actionable info
              the trade panel doesn't already cover. */}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_400px]">
            <section className="min-w-0 rounded-2xl border border-border bg-bgCard p-4 sm:p-6">
              {renderEconomics(detail)}
            </section>
            <aside className="flex min-w-0 flex-col gap-3">
              {renderTradeForm({ detail, user, market, syBalance })}
            </aside>
          </div>
        </div>
      </WalletGate>
      <Footer />
    </main>
  );
}
