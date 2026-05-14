"use client";

/**
 * Buy PT sub-page — strategy economics on the left, BuyPtForm on the right.
 * Same shell as /yt and /lp; copy in this file is what changes.
 */
import { MarketSubPageShell } from "@/components/MarketSubPageShell";
import { BuyPtForm } from "@/components/forms/BuyPtForm";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate } from "@/components/MarketPositionCard";

export default function PtPage({ params }: { params: Promise<{ address: string }> }) {
  return (
    <MarketSubPageShell
      params={params}
      crumb="Buy PT"
      renderEconomics={(detail) => <PtEconomics detail={detail} />}
      renderTradeForm={({ detail, user, market, syBalance }) => (
        <BuyPtForm market={market} detail={detail} user={user} syBalance={syBalance} />
      )}
    />
  );
}

function PtEconomics({ detail }: { detail: MarketDetail }) {
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ptRate = ptToSyRate(apy, days);
  const matures = new Date(Number(detail.expiry) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  // Worked example: 1000 SY → buy 1000/ptRate PT today → redeem same count
  // of SY at maturity. The delta is the locked-in profit.
  const inputSy = 1000;
  const ptOut = inputSy / Math.max(1e-9, ptRate);
  const profit = ptOut - inputSy;

  return (
    <div>
      <h2 className="text-[18px] font-semibold tracking-tight text-text">Fixed Yield</h2>

      <div className="mt-4 rounded-xl border border-border bg-white/[0.02] px-4 py-3">
        <div className="text-[10px] uppercase tracking-[1.5px] text-textDim">Locked in</div>
        <div className="mt-1 font-mono text-[20px] font-bold text-text">
          {apy.toFixed(2)}% Fixed APY
        </div>
        <div className="mt-0.5 text-[12px] text-textSec">
          {days} days · matures {matures}
        </div>
      </div>

      <div className="mt-5">
        <PtYieldChart ptRate={ptRate} apyPct={apy} />
      </div>

      <ol className="mt-5 space-y-3 text-[13px] leading-relaxed text-textSec">
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            1
          </span>
          <span>
            Pay <span className="font-mono text-text">{ptRate.toFixed(4)} SY</span> today.
            PT trades at a discount (less than 1 SY).
          </span>
        </li>
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            2
          </span>
          <span>
            Hold PT until <span className="text-text">{matures}</span>.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            3
          </span>
          <span>
            Redeem 1:1 for SY — guaranteed. The protocol holds the SY for you the
            entire term; the redemption is unconditional.
          </span>
        </li>
      </ol>

      <div className="mt-5 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-[12px] leading-relaxed text-textSec">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1.5px] text-success">
          Example
        </div>
        Deposit <span className="font-mono text-text">{inputSy} SY</span> → buy{" "}
        <span className="font-mono text-text">{ptOut.toFixed(2)} PT</span> today →
        redeem <span className="font-mono text-text">{ptOut.toFixed(2)} SY</span> in {days} days →
        <span className="font-mono text-success"> +{profit.toFixed(2)} SY</span> ({apy.toFixed(2)}% APY).
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[1.5px] text-textDim">
          Risks
        </div>
        <ul className="space-y-1.5 text-[12px] leading-relaxed text-textSec">
          <li>Smart contract risk — Fission, Router, SY adapter, HTS tokens.</li>
          <li>
            SY value can drift — backed by a SaucerSwap V2 LP; USDC/WHBAR pool moves
            cause impermanent-loss-style $ swing in the SY itself.
          </li>
          <li>AMM liquidity may be thin if you try to sell PT early.</li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Bigger PT yield-curve chart. Straight line from (today, 0) to
 * (maturity, +yield). 600×200 viewbox; right-edge label hangs off the
 * line endpoint.
 */
function PtYieldChart({ ptRate, apyPct }: { ptRate: number; apyPct: number }) {
  const W = 600;
  const H = 200;
  const padL = 30;
  const padR = 130;
  const padT = 22;
  const padB = 32;
  const x0 = padL;
  const x1 = W - padR;
  const y0 = H - padB;
  const y1 = padT;
  const yieldAtMaturity = Math.max(0, 1 - ptRate);
  const label = `+${yieldAtMaturity.toFixed(4)} SY`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full text-success"
      role="img"
      aria-label={`PT yield curve — accrues ${label} over the term, ${apyPct.toFixed(2)}% APY`}
    >
      <line x1={x0} y1={y0} x2={x1} y2={y0} stroke="currentColor" strokeOpacity={0.15} strokeDasharray="3 4" />
      <line x1={x0} y1={y1} x2={x1} y2={y1} stroke="currentColor" strokeOpacity={0.08} strokeDasharray="3 4" />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={x0} cy={y0} r={4} fill="currentColor" fillOpacity={0.4} />
      <circle cx={x1} cy={y1} r={5} fill="currentColor" />
      <text x={x0} y={H - 8} fill="currentColor" fillOpacity={0.55} fontSize={11}>
        today
      </text>
      <text x={x1} y={H - 8} fill="currentColor" fillOpacity={0.55} fontSize={11} textAnchor="end">
        maturity
      </text>
      <text x={x1 + 8} y={y1 + 4} fill="currentColor" fontSize={13} fontWeight={600}>
        {label}
      </text>
      <text x={x1 + 8} y={y1 + 20} fill="currentColor" fillOpacity={0.6} fontSize={11}>
        {apyPct.toFixed(2)}% APY
      </text>
    </svg>
  );
}
