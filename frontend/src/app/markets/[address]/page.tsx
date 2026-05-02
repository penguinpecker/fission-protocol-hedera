"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { parseUnits } from "viem";
import { Nav } from "@/components/Nav";
import { useMarketDetail, useUserPosition, MarketDetail } from "@/hooks/useMarket";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { erc20WriteAbi, routerAbi, marketWriteAbi } from "@/lib/abis-write";
import {
  impliedApyPct,
  daysUntil,
  formatBigInt,
} from "@/hooks/useMarkets";

type Strategy = "pt" | "yt" | "split";

const STRATEGIES: { id: Strategy; title: string; sub: string; risk: string }[] = [
  { id: "pt", title: "Fixed yield", sub: "Buy PT", risk: "Low" },
  { id: "yt", title: "Long yield", sub: "Buy YT", risk: "High" },
  { id: "split", title: "Mint PT+YT", sub: "Split SY", risk: "Med" },
];

export default function MarketDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: marketAddrParam } = use(params);
  const market = marketAddrParam as `0x${string}`;
  const { data: detail, isLoading } = useMarketDetail(market);
  const { address: user } = useAccount();
  const { data: position } = useUserPosition(market, detail, user);

  const [strategy, setStrategy] = useState<Strategy>("pt");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50); // 0.5%

  const ptPriceApy = useMemo(() => {
    if (!detail) return null;
    const apy = impliedApyPct(detail.lastLnImpliedRate);
    return apy;
  }, [detail]);

  if (isLoading || !detail) {
    return (
      <main className="min-h-screen">
        <Nav />
        <div className="mx-auto max-w-[1100px] px-6 py-10">
          <div className="h-32 animate-pulse rounded-2xl border border-border bg-bgCard" />
        </div>
      </main>
    );
  }

  const expired = Date.now() / 1000 >= Number(detail.expiry);
  const dec = detail.syDecimals;

  return (
    <main className="min-h-screen">
      <Nav />

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
            {expired && <span className="ml-2 rounded bg-error/10 px-2 py-0.5 text-[10px] font-semibold text-error">EXPIRED</span>}
          </div>
        </div>

        <div className="mb-3 grid grid-cols-5 gap-px overflow-hidden rounded-2xl bg-border">
          <Stat label="Implied APY" value={ptPriceApy !== null ? `${ptPriceApy.toFixed(2)}%` : "—"} />
          <Stat label="SY locked" value={formatBigInt(detail.totalSy, dec, 2)} mono />
          <Stat label="PT in pool" value={formatBigInt(detail.totalPt, dec, 2)} mono />
          <Stat label="LP supply" value={formatBigInt(detail.lpSupply, 18, 2)} mono />
          <Stat label="SY rate" value={formatBigInt(detail.syExchangeRate, 18, 4)} mono />
        </div>

        {position && user && (
          <div className="mb-6 grid grid-cols-5 gap-1.5">
            <UserStat label="Your SY" v={formatBigInt(position.sy, dec)} />
            <UserStat label="Your PT" v={formatBigInt(position.pt, dec)} />
            <UserStat label="Your YT" v={formatBigInt(position.yt, dec)} />
            <UserStat label="Your LP" v={formatBigInt(position.lp, 18)} />
            <UserStat label="Claimable yield" v={formatBigInt(position.claimableYield, dec)} accent="success" />
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          <PositionInfoCard detail={detail} expired={expired} />

          <TradeCard
            market={market}
            detail={detail}
            strategy={strategy}
            setStrategy={setStrategy}
            amount={amount}
            setAmount={setAmount}
            slippageBps={slippageBps}
            setSlippageBps={setSlippageBps}
            user={user}
          />
        </div>

        {expired && user && position && (position.pt > 0n || position.yt > 0n) && (
          <PostExpiryActions market={market} position={position} />
        )}
      </div>
    </main>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-bgCard px-5 py-4">
      <div className="mb-1 text-[10px] uppercase tracking-[1px] text-textDim">{label}</div>
      <div className={`text-[20px] font-bold tracking-tight text-text ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function UserStat({ label, v, accent }: { label: string; v: string; accent?: "success" }) {
  return (
    <div className="rounded-lg bg-white/[0.02] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.5px] text-textDim">{label}</div>
      <div className={`font-mono text-[13px] font-semibold ${accent === "success" ? "text-success" : "text-text"}`}>{v}</div>
    </div>
  );
}

function PositionInfoCard({ detail, expired }: { detail: MarketDetail; expired: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-bgCard p-6">
      <h3 className="mb-3 text-sm font-semibold">Strategy guide</h3>
      <ul className="space-y-3 text-[13px] leading-relaxed text-textSec">
        <li>
          <span className="text-text">Buy PT</span> — lock in fixed yield. PT trades at a discount and redeems for{" "}
          <code className="text-xs text-textDim">amount · 1e18 / globalIndex</code> SY at maturity.
        </li>
        <li>
          <span className="text-text">Buy YT</span> — leverage on rising rates. The router splits your SY, sells PT in
          the pool, and returns YT + the SY proceeds. Your effective YT cost = SY paid − refund.
        </li>
        <li>
          <span className="text-text">Mint PT+YT</span> — pure split, no fee. Equal PT + YT minted 1:1 against the SY
          you deposit. Ideal if you plan to LP both sides or sell one off later.
        </li>
        {expired && (
          <li className="text-error">Market expired — only redeem and claim-yield are available.</li>
        )}
      </ul>
    </div>
  );
}

interface TradeCardProps {
  market: `0x${string}`;
  detail: MarketDetail;
  strategy: Strategy;
  setStrategy: (s: Strategy) => void;
  amount: string;
  setAmount: (v: string) => void;
  slippageBps: number;
  setSlippageBps: (n: number) => void;
  user: `0x${string}` | undefined;
}

function TradeCard({
  market,
  detail,
  strategy,
  setStrategy,
  amount,
  setAmount,
  slippageBps,
  setSlippageBps,
  user,
}: TradeCardProps) {
  const { writeContract, isPending } = useWriteContract();
  const routerDeployed = isDeployed(ADDRESSES.router);

  const onTrade = () => {
    if (!user || !amount || !routerDeployed) return;
    const amt = parseUnits(amount, detail.syDecimals);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const minOut = (amt * BigInt(10_000 - slippageBps)) / 10_000n;

    if (strategy === "split") {
      // Direct market.split() — no router needed; no slippage on a 1:1 wrap.
      writeContract({
        abi: marketWriteAbi,
        address: market,
        functionName: "split",
        args: [amt],
      });
      return;
    }

    if (strategy === "pt") {
      // Use router buyPT-style: pay SY exact, receive PT.
      // Router signature: swapExactSyForPt(market, syIn, ptOut, receiver, deadline).
      // We approximate ptOut from amount (1 PT ≈ 1/ptPrice SY); user-readable approx.
      writeContract({
        abi: routerAbi,
        address: ADDRESSES.router,
        functionName: "swapExactSyForPt",
        args: [market, amt, minOut, user, deadline],
      });
      return;
    }

    if (strategy === "yt") {
      writeContract({
        abi: routerAbi,
        address: ADDRESSES.router,
        functionName: "buyYT",
        args: [market, amt, minOut, user, deadline],
      });
    }
  };

  return (
    <aside className="flex flex-col gap-3">
      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[2px] text-textDim">Strategy</div>
        <div className="flex gap-1">
          {STRATEGIES.map((s) => {
            const active = strategy === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setStrategy(s.id)}
                className={`flex-1 rounded-lg border px-2 py-2.5 text-[13px] font-medium transition ${
                  active
                    ? "border-borderHover bg-white/[0.06] text-text"
                    : "border-border text-textDim hover:bg-white/[0.04]"
                }`}
              >
                {s.sub}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
          {strategy === "split" ? "Split SY → PT + YT" : strategy === "pt" ? "Buy PT" : "Buy YT"}
        </div>

        <label className="mb-3 block">
          <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
            You pay (SY)
          </span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            className="w-full rounded-[10px] border border-border bg-bgInput px-4 py-3.5 font-mono text-base text-text outline-none transition focus:border-borderHover"
          />
        </label>

        {strategy !== "split" && (
          <label className="mb-3 block">
            <span className="mb-1.5 block text-xs text-textSec">
              Slippage tolerance: {(slippageBps / 100).toFixed(2)}%
            </span>
            <input
              type="range"
              min={5}
              max={500}
              value={slippageBps}
              onChange={(e) => setSlippageBps(Number(e.target.value))}
              className="w-full"
            />
          </label>
        )}

        <button
          type="button"
          disabled={!user || !amount || isPending || (strategy !== "split" && !routerDeployed)}
          onClick={onTrade}
          className="w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!user
            ? "Connect wallet"
            : !amount
              ? "Enter amount"
              : isPending
                ? "Confirming…"
                : strategy === "split"
                  ? `Split ${amount} SY`
                  : strategy === "pt"
                    ? "Buy PT"
                    : "Buy YT"}
        </button>

        {strategy !== "split" && !routerDeployed && (
          <p className="mt-2 text-[11px] text-error">Router not deployed yet — split-only flow available.</p>
        )}
      </div>
    </aside>
  );
}

function PostExpiryActions({
  market,
  position,
}: {
  market: `0x${string}`;
  position: { pt: bigint; yt: bigint };
}) {
  const { writeContract, isPending } = useWriteContract();
  const { address: user } = useAccount();

  const redeem = () => {
    if (!user) return;
    writeContract({
      abi: marketWriteAbi,
      address: market,
      functionName: "redeemAfterExpiry",
      args: [position.pt, position.yt, user],
    });
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
