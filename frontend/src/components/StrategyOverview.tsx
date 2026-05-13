"use client";

/**
 * Three-strategy overview block, shown on the market detail page below the
 * user's position summary. Each card has a tag, title, big metric, one-line
 * pitch, inline SVG chart, "why pick this" paragraph, and a CTA that links
 * to the strategy sub-page (`/markets/[addr]/pt|yt|lp`).
 *
 * The overview is purely an entry point — full trade UI lives on the
 * sub-pages.
 */

import Link from "next/link";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate, ytToSyRate } from "@/components/MarketPositionCard";

interface OverviewProps {
  detail: MarketDetail;
  /** Market address — used to build sub-page hrefs. */
  market: `0x${string}`;
}

export function StrategyOverview({ detail, market }: OverviewProps) {
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const apyDisplay = apy === null ? 0 : apy;
  return (
    <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
      <PtCard detail={detail} days={days} apy={apyDisplay} market={market} />
      <YtCard detail={detail} days={days} apy={apyDisplay} market={market} />
      <LpCard detail={detail} market={market} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────── shared shell */

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl border border-border bg-bgCard p-5 transition hover:border-borderHover hover:bg-white/[0.02]">
      {children}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
      {children}
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-[18px] font-semibold tracking-tight">{children}</div>;
}

function BigMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="mt-4">
      <div className="font-mono text-[28px] font-bold leading-none tracking-tight">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-[1.5px] text-textDim">{label}</div>
    </div>
  );
}

function Pitch({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[12px] leading-relaxed text-textSec">{children}</p>;
}

function WhyPick({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1.5px] text-textDim">
        Why pick this
      </div>
      <p className="text-[12px] leading-relaxed text-textSec">{children}</p>
    </div>
  );
}

function CtaLink({ children, href }: { children: React.ReactNode; href: string }) {
  return (
    <Link
      href={href}
      className="mt-5 block w-full rounded-[10px] bg-white px-4 py-2.5 text-center text-[13px] font-semibold text-bg transition hover:opacity-90"
    >
      {children}
    </Link>
  );
}

/* ─────────────────────────────────────────────────────── PT card */

function PtCard({
  detail: _detail,
  days,
  apy,
  market,
}: {
  detail: MarketDetail;
  days: number;
  apy: number;
  market: `0x${string}`;
}) {
  const ptRate = ptToSyRate(apy, days);
  const yieldAtMaturity = Math.max(0, 1 - ptRate);

  return (
    <CardShell>
      <Tag>Fixed yield</Tag>
      <Title>Buy PT</Title>

      <BigMetric value={`${apy.toFixed(2)}%`} label="Fixed APY" />

      <Pitch>
        Pay {ptRate.toFixed(4)} SY today, receive 1 SY at maturity ({days} days).
      </Pitch>

      <div className="mt-4">
        <PtChart yieldAtMaturity={yieldAtMaturity} />
      </div>

      <WhyPick>
        You want a guaranteed return, locked in today. Best if you expect yields to fall or stay below {apy.toFixed(2)}% over the next {days} days.
      </WhyPick>

      <CtaLink href={`/markets/${market}/pt`}>Open Buy PT →</CtaLink>
    </CardShell>
  );
}

function PtChart({ yieldAtMaturity }: { yieldAtMaturity: number }) {
  const W = 280;
  const H = 80;
  const padL = 8;
  const padR = 78;
  const padT = 12;
  const padB = 18;
  const x0 = padL;
  const x1 = W - padR;
  const y0 = H - padB;
  const y1 = padT;
  const label = `+${yieldAtMaturity.toFixed(4)} SY`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full text-success"
      role="img"
      aria-label={`PT yield curve, accruing ${label} over the term`}
    >
      <line x1={x0} y1={y0} x2={x1} y2={y0} stroke="currentColor" strokeOpacity={0.15} strokeDasharray="2 3" />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx={x1} cy={y1} r={3} fill="currentColor" />
      <text x={x0} y={H - 4} fill="currentColor" fillOpacity={0.55} fontSize={9}>
        today
      </text>
      <text x={x1 + 6} y={y1 + 4} fill="currentColor" fontSize={11} fontWeight={600}>
        {label}
      </text>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────── YT card */

function YtCard({
  detail: _detail,
  days,
  apy,
  market,
}: {
  detail: MarketDetail;
  days: number;
  apy: number;
  market: `0x${string}`;
}) {
  const ytRate = ytToSyRate(apy, days);
  return (
    <CardShell>
      <Tag>Long yield</Tag>
      <Title>Buy YT</Title>

      <BigMetric value={`${apy.toFixed(2)}% implied`} label="Long the yield" />

      <Pitch>
        Pay {ytRate.toFixed(4)} SY today, earn variable yield on 1 SY notional for {days} days.
      </Pitch>

      <div className="mt-4">
        <YtChart apy={apy} />
      </div>

      <WhyPick>
        You think the pool will earn MORE than {apy.toFixed(2)}% APY over the next {days} days. Leveraged exposure to yield — could 2-5x or go to ~0.
      </WhyPick>

      <CtaLink href={`/markets/${market}/yt`}>Open Buy YT →</CtaLink>
    </CardShell>
  );
}

function YtChart({ apy }: { apy: number }) {
  const W = 280;
  const H = 80;
  const padL = 8;
  const padR = 78;
  const padT = 14;
  const padB = 12;
  const N = 32;

  const seed = Math.max(1, Math.floor(apy * 100));
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 10_000) / 10_000;
  };

  const band = apy * 0.15 + 0.5;
  const series: number[] = [];
  let v = apy;
  for (let i = 0; i < N; i++) {
    const step = (rand() - 0.5) * band * 0.4;
    v = v + step;
    v = v + (apy - v) * 0.12;
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
      <line x1={padL} y1={y(apy)} x2={W - padR} y2={y(apy)} stroke="currentColor" strokeOpacity={0.18} strokeDasharray="2 3" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={3} fill="currentColor" />
      <text x={lastX + 6} y={lastY + 4} fill="currentColor" fontSize={11} fontWeight={600}>
        {apy.toFixed(2)}%
      </text>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────── LP card */

function LpCard({
  detail,
  market,
}: {
  detail: MarketDetail;
  market: `0x${string}`;
}) {
  const totalPt = Number(detail.totalPt);
  const totalSy = Number(detail.totalSy);
  const sum = totalPt + totalSy;
  const ptShare = sum > 0 ? totalPt / sum : 0.5;
  const syShare = sum > 0 ? totalSy / sum : 0.5;
  const hasComposition = sum > 0;

  return (
    <CardShell>
      <Tag>Liquidity</Tag>
      <Title>Provide LP</Title>

      <BigMetric value="Earn fees" label="Pool fees + rewards" />

      <Pitch>
        Hold ~{(ptShare * 100).toFixed(0)}% PT + ~{(syShare * 100).toFixed(0)}% SY exposure. Trading fees accrue, LP supply grows.
      </Pitch>

      <div className="mt-4 flex items-center gap-4">
        <LpDonut ptShare={ptShare} syShare={syShare} hasComposition={hasComposition} />
        <div className="flex flex-col gap-1.5 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-text" />
            <span className="text-textSec">PT {hasComposition ? `${(ptShare * 100).toFixed(0)}%` : "—"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-textDim" />
            <span className="text-textSec">SY {hasComposition ? `${(syShare * 100).toFixed(0)}%` : "—"}</span>
          </div>
        </div>
      </div>

      <WhyPick>
        You want passive yield without picking a side. LPs earn trading fees + protocol rewards while exposed to both sides of the AMM.
      </WhyPick>

      <CtaLink href={`/markets/${market}/lp`}>Open LP →</CtaLink>
    </CardShell>
  );
}

function LpDonut({
  ptShare,
  syShare,
  hasComposition,
}: {
  ptShare: number;
  syShare: number;
  hasComposition: boolean;
}) {
  const size = 72;
  const r = 28;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const ptLen = circ * ptShare;
  const syLen = circ * syShare;

  if (!hasComposition) {
    return (
      <svg viewBox={`0 0 ${size} ${size}`} className="h-[72px] w-[72px] text-textDim" role="img" aria-label="No pool composition data">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeOpacity={0.4} strokeWidth={8} />
      </svg>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-[72px] w-[72px]"
      role="img"
      aria-label={`Pool composition donut, ${(ptShare * 100).toFixed(0)}% PT and ${(syShare * 100).toFixed(0)}% SY`}
    >
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        <circle
          className="text-text"
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={8}
          strokeDasharray={`${ptLen} ${circ - ptLen}`}
          strokeDashoffset={0}
          strokeLinecap="butt"
        />
        <circle
          className="text-textDim"
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={8}
          strokeDasharray={`${syLen} ${circ - syLen}`}
          strokeDashoffset={-ptLen}
          strokeLinecap="butt"
        />
      </g>
    </svg>
  );
}
