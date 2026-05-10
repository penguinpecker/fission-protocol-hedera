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
          <PositionInfoCard detail={detail} expired={expired} strategy={strategy} />

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

function PositionInfoCard({ detail, expired, strategy }: { detail: MarketDetail; expired: boolean; strategy: Strategy }) {
  const content = STRATEGY_EXPLAINERS[strategy];
  return (
    <div className="rounded-2xl border border-border bg-bgCard p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">{content.title}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1px] ${content.riskTone}`}>
          {content.riskLabel}
        </span>
      </div>

      <p className="mb-4 text-[13px] leading-relaxed text-textSec">{content.summary}</p>

      <div className="mb-4 space-y-3 text-[13px] leading-relaxed">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1px] text-textDim">How yield reaches you</div>
          <p className="text-textSec">{content.yieldSource}</p>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1px] text-textDim">Worked example</div>
          <p className="whitespace-pre-line text-textSec">{content.example}</p>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1px] text-textDim">Risk profile</div>
          <p className="text-textSec">{content.risk}</p>
        </div>
      </div>

      {expired && (
        <p className="mb-4 rounded-lg border border-error/40 bg-error/5 px-3 py-2 text-[12px] text-error">
          Market expired — AMM is closed. PT redeems 1:1 with SY. YT keeps earning V3 fees forever; do not burn it.
        </p>
      )}

      <a
        href="https://github.com/penguinpecker/fission-protocol-hedera/blob/main/docs/ECONOMICS.md"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-textDim transition hover:text-text"
      >
        Read the full economics doc →
      </a>
    </div>
  );
}

const STRATEGY_EXPLAINERS = {
  pt: {
    title: "Buy PT — fixed yield",
    riskLabel: "Low risk",
    riskTone: "bg-success/10 text-success",
    summary:
      "PT is a zero-coupon bond on SY. You buy at a discount today, redeem 1:1 for SY at maturity. The discount is your yield, locked in at buy time.",
    yieldSource:
      "Your yield is paid by YT buyers — speculators on the other side of the trade who pay a premium for variable yield. The protocol holds the SY for you the entire term; redemption is 1:1 and unconditional.",
    example:
      "• Buy 1 PT for 0.985 SY (1.5% discount over 90 days ≈ 6% APY)\n• 90 days later, redeem 1 PT → receive 1 SY\n• Profit: 0.015 SY (the discount), regardless of what V3 fees actually do",
    risk:
      "Fixed-rate from your perspective. Main risks: SY value moves with WHBAR/USDC pool (impermanent-loss style), smart contract risk, and Hedera/SaucerSwap platform risk. Protocol always has 1 SY waiting per PT — your principal is on-chain and reserved.",
  },
  yt: {
    title: "Buy YT — variable yield",
    riskLabel: "High risk",
    riskTone: "bg-error/10 text-error",
    summary:
      "YT is a leveraged claim on SaucerSwap V3 trading fees. You pay a premium today, receive USDC + WHBAR continuously as the V3 pool earns fees. YT does NOT expire — it earns forever.",
    yieldSource:
      "SaucerSwap V3 traders swap WHBAR↔USDC and pay a 0.3% fee. Our SY's NFT collects its pro-rata share. Anyone calling harvest() pulls those fees into the SY, which distributes them to YT holders proportional to YT balance. You can claim anytime.",
    example:
      "• Buy $100 of YT at 0.015 SY/YT (≈ 6% implied APY)\n• If V3 volume comes in HIGHER → claim $250 over 90 days = 150% gain\n• If V3 volume comes in LOWER → claim $33 over 90 days = 67% loss\n• Either way, YT keeps earning forever after expiry — your loss can recover with time",
    risk:
      "Variable. Effective leverage on V3 yield ≈ 1 / implied-rate (≈ 67× at 1.5%). You can lose most of your entry capital if fees underperform — but YT itself never goes to 0; it stays a perpetual fee claim. Maximum loss capped at entry cost.",
  },
  split: {
    title: "Split SY → PT + YT (no fee)",
    riskLabel: "Neutral",
    riskTone: "bg-textDim/10 text-textDim",
    summary:
      "Pure 1:1 mint. 1 SY in → 1 PT + 1 YT out. No AMM trade, no slippage, no fee. Use when you want both sides — to LP, to sell one half, or to hedge.",
    yieldSource:
      "You're not buying yield here — you're creating both halves of it. The PT side will pay back 1 SY at maturity. The YT side will earn V3 fees over time. Selling PT for SY locks in fixed-rate proceeds; selling YT for SY locks in the implied yield premium up front.",
    example:
      "• Deposit 1 SY → receive 1 PT + 1 YT\n• Common play: sell PT in AMM for ~0.985 SY, sell YT for ~0.015 SY → recover 1 SY (break-even, but you've taken zero directional risk)\n• LP play: deposit both sides into the AMM and earn 99% of swap fees",
    risk:
      "Neutral at the moment of split. Risk shows up in what you do with PT and YT after. Splitting itself can't lose you money beyond AMM fees on subsequent sells.",
  },
} satisfies Record<Strategy, {
  title: string;
  riskLabel: string;
  riskTone: string;
  summary: string;
  yieldSource: string;
  example: string;
  risk: string;
}>;

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
