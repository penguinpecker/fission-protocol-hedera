"use client";

/**
 * YT sub-page — strategy economics on the left, Buy/Sell form on the right.
 * Tab toggles between BuyYtForm (SY → YT via router.buyYT split+sell-PT) and
 * SellYtForm (YT → SY via market.swapExactYtForSy direct call).
 */
import { useState } from "react";
import { MarketSubPageShell } from "@/components/MarketSubPageShell";
import { BuyYtForm } from "@/components/forms/BuyYtForm";
import { SellYtForm } from "@/components/forms/SellYtForm";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, impliedApyPct } from "@/hooks/useMarkets";
import { ytToSyRate } from "@/components/MarketPositionCard";

export default function YtPage({ params }: { params: Promise<{ address: string }> }) {
  return (
    <MarketSubPageShell
      params={params}
      crumb="YT"
      renderEconomics={(detail) => <YtEconomics detail={detail} />}
      renderTradeForm={({ detail, user, market, syBalance }) => (
        <YtTradeForm detail={detail} user={user} market={market} syBalance={syBalance} />
      )}
    />
  );
}

function YtTradeForm({
  detail,
  user,
  market,
  syBalance,
}: {
  detail: MarketDetail;
  user: `0x${string}` | undefined;
  market: `0x${string}`;
  syBalance: bigint;
}) {
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  return (
    <div className="flex flex-col gap-3">
      <div className="inline-flex w-fit rounded-[8px] border border-border bg-bgInput p-0.5 font-mono text-[10px] uppercase tracking-[1.5px]">
        <button
          type="button"
          onClick={() => setMode("buy")}
          className={`rounded-[6px] px-3 py-1.5 transition ${
            mode === "buy"
              ? "bg-white/[0.08] text-text"
              : "text-textDim hover:text-text"
          }`}
        >
          Buy YT
        </button>
        <button
          type="button"
          onClick={() => setMode("sell")}
          className={`rounded-[6px] px-3 py-1.5 transition ${
            mode === "sell"
              ? "bg-white/[0.08] text-text"
              : "text-textDim hover:text-text"
          }`}
        >
          Sell YT
        </button>
      </div>
      {mode === "buy" ? (
        <BuyYtForm market={market} detail={detail} user={user} syBalance={syBalance} />
      ) : (
        <SellYtForm market={market} detail={detail} user={user} />
      )}
    </div>
  );
}

function YtEconomics({ detail }: { detail: MarketDetail }) {
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ytPrice = ytToSyRate(apy, days);

  // Scenarios: payoff per 1 SY of YT spend. YT earns its pro-rata share of
  // fees on 1/ytPrice underlying SY-notional over the term.
  const notional = ytPrice > 0 ? 1 / ytPrice : 0;
  const payoff = (yieldPct: number) => {
    // accrued fees over `days` at `yieldPct` annualized, on `notional` SY
    const accrued = notional * (yieldPct / 100) * (days / 365);
    // Net: accrued − cost of YT (1 SY here, since notional was derived from 1 SY of cost)
    return accrued - 1;
  };

  return (
    <div>
      <h2 className="text-[18px] font-semibold tracking-tight text-text">Long Yield</h2>

      <div className="mt-4 rounded-xl border border-border bg-white/[0.02] px-4 py-3">
        <div className="text-[10px] uppercase tracking-[1.5px] text-textDim">Breakeven</div>
        <div className="mt-1 font-mono text-[20px] font-bold text-text">
          {apy.toFixed(2)}% APY · {days} days
        </div>
        <div className="mt-0.5 text-[12px] text-textSec">
          Pool must earn above the implied rate for YT buyers to profit.
        </div>
      </div>

      <div className="mt-5">
        <YtChart apy={apy} />
      </div>

      <ol className="mt-5 space-y-3 text-[13px] leading-relaxed text-textSec">
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            1
          </span>
          <span>
            Pay <span className="font-mono text-text">{ytPrice.toFixed(4)} SY</span> for 1 YT.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            2
          </span>
          <span>
            Earn V3 LP fees + protocol rewards proportional to YT held — they accrue continuously into the SY and you can claim anytime.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            3
          </span>
          <span>
            If pool yields &gt; <span className="font-mono text-text">{apy.toFixed(2)}%</span> over the term → profit. If &lt; → loss.
            YT continues earning forever; your loss can recover after expiry.
          </span>
        </li>
      </ol>

      <div className="mt-5 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-[12px] leading-relaxed text-textSec">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[1.5px] text-warning">
          Payoff scenarios (per 1 SY of YT cost)
        </div>
        <div className="grid grid-cols-1 gap-2 font-mono sm:grid-cols-3">
          <Scenario yieldPct={4} payoff={payoff(4)} />
          <Scenario yieldPct={8} payoff={payoff(8)} />
          <Scenario yieldPct={16} payoff={payoff(16)} />
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[1.5px] text-textDim">
          Risks
        </div>
        <ul className="space-y-1.5 text-[12px] leading-relaxed text-textSec">
          <li>Yield uncertainty — V3 swap volume is the only source of YT income.</li>
          <li>Fee accrual delays — fees are pulled into the SY by anyone calling harvest(); occasional lag is normal.</li>
          <li>Gas to claim — every claim is its own tx; smaller positions may not be worth claiming frequently.</li>
        </ul>
      </div>
    </div>
  );
}

function Scenario({ yieldPct, payoff }: { yieldPct: number; payoff: number }) {
  const tone = payoff >= 0 ? "text-success" : "text-error";
  return (
    <div className="rounded-lg border border-border bg-white/[0.02] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[1px] text-textDim">{yieldPct}% pool</div>
      <div className={`mt-0.5 text-[13px] font-bold ${tone}`}>
        {payoff >= 0 ? "+" : ""}
        {payoff.toFixed(2)} SY
      </div>
    </div>
  );
}

/**
 * Bigger implied-APY sparkline. Same Mulberry32 walk as the overview card
 * but at 600×200 for the sub-page.
 */
function YtChart({ apy }: { apy: number }) {
  const W = 600;
  const H = 200;
  const padL = 30;
  const padR = 130;
  const padT = 24;
  const padB = 30;
  const N = 64;

  const seed = Math.max(1, Math.floor(apy * 100));
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 10_000) / 10_000;
  };

  const band = apy * 0.18 + 0.5;
  const series: number[] = [];
  let v = apy;
  for (let i = 0; i < N; i++) {
    const step = (rand() - 0.5) * band * 0.4;
    v = v + step;
    v = v + (apy - v) * 0.1;
    series.push(v);
  }
  const lo = Math.min(...series, apy - band);
  const hi = Math.max(...series, apy + band);
  const range = Math.max(1e-6, hi - lo);

  const x = (i: number) => padL + ((W - padL - padR) * i) / (N - 1);
  const y = (val: number) => padT + (H - padT - padB) * (1 - (val - lo) / range);

  const d = series.map((val, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(val).toFixed(2)}`).join(" ");
  const lastX = x(N - 1);
  const lastVal = series[series.length - 1] ?? apy;
  const lastY = y(lastVal);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full text-warning"
      role="img"
      aria-label={`Implied APY sparkline around ${apy.toFixed(2)}%`}
    >
      <line x1={padL} y1={y(apy)} x2={W - padR} y2={y(apy)} stroke="currentColor" strokeOpacity={0.18} strokeDasharray="3 4" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={4.5} fill="currentColor" />
      <text x={lastX + 8} y={lastY + 4} fill="currentColor" fontSize={13} fontWeight={600}>
        {apy.toFixed(2)}%
      </text>
      <text x={padL} y={H - 8} fill="currentColor" fillOpacity={0.55} fontSize={11}>
        implied APY (illustrative)
      </text>
    </svg>
  );
}
