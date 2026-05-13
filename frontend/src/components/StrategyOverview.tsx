"use client";

/**
 * Three-strategy overview block, shown on the market detail page below the
 * user's position summary and above the TradeCard. Renders three side-by-side
 * "pick your path" cards (Buy PT, Buy YT, Provide LP). Each card has a tag,
 * title, big metric, one-line pitch, inline SVG chart, "why pick this"
 * paragraph, and a CTA that scrolls to the TradeCard and selects the strategy.
 *
 * The overview is purely an entry-point — the actual trade UI lives in
 * TradeCard. The page lifts the click handler so we can call
 * setStrategy(s) and scrollIntoView the trade card in one motion.
 */

import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate, ytToSyRate } from "@/components/MarketPositionCard";

type PickStrategy = "pt" | "yt" | "split";

interface OverviewProps {
  detail: MarketDetail;
  onPick: (s: PickStrategy) => void;
}

export function StrategyOverview({ detail, onPick }: OverviewProps) {
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const apyDisplay = apy === null ? 0 : apy;
  return (
    <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
      <PtCard detail={detail} days={days} apy={apyDisplay} onPick={onPick} />
      <YtCard detail={detail} days={days} apy={apyDisplay} onPick={onPick} />
      <LpCard detail={detail} onPick={onPick} />
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

function Cta({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-5 w-full rounded-[10px] bg-white px-4 py-2.5 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────────────────────────────── PT card */

function PtCard({
  detail: _detail,
  days,
  apy,
  onPick,
}: {
  detail: MarketDetail;
  days: number;
  apy: number;
  onPick: (s: PickStrategy) => void;
}) {
  const ptRate = ptToSyRate(apy, days);
  const yieldAtMaturity = Math.max(0, 1 - ptRate); // "+0.018 SY" style label

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

      <Cta onClick={() => onPick("pt")}>Open Buy PT →</Cta>
    </CardShell>
  );
}

/**
 * PT yield-growth curve: clean line from bottom-left (today, 0 yield) to
 * top-right (maturity, +yield SY). Right-edge horizontal label shows the
 * final yield value formatted to 4dp.
 *
 * 280×80 viewbox; we leave ~70px on the right edge for the label so the
 * line ends around x=210 to avoid colliding with the text.
 */
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
      {/* baseline */}
      <line
        x1={x0}
        y1={y0}
        x2={x1}
        y2={y0}
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeDasharray="2 3"
      />
      {/* growth line */}
      <line
        x1={x0}
        y1={y0}
        x2={x1}
        y2={y1}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      {/* end-point dot */}
      <circle cx={x1} cy={y1} r={3} fill="currentColor" />
      {/* "today" label at left */}
      <text x={x0} y={H - 4} fill="currentColor" fillOpacity={0.55} fontSize={9}>
        today
      </text>
      {/* right-edge yield label */}
      <text
        x={x1 + 6}
        y={y1 + 4}
        fill="currentColor"
        fontSize={11}
        fontWeight={600}
      >
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
  onPick,
}: {
  detail: MarketDetail;
  days: number;
  apy: number;
  onPick: (s: PickStrategy) => void;
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

      <Cta onClick={() => onPick("yt")}>Open Buy YT →</Cta>
    </CardShell>
  );
}

/**
 * Deterministic, seeded pseudo-random walk that oscillates around the
 * current implied APY. We don't have historical data, so this is a
 * representative sparkline rather than a real series — but it's stable
 * across renders (seed derived from APY) so it doesn't jitter on re-render.
 *
 * 32 sample points, ±15% of APY noise band. Walk uses a simple LCG seeded
 * from a hash of the APY bucket so identical APYs render identically.
 */
function YtChart({ apy }: { apy: number }) {
  const W = 280;
  const H = 80;
  const padL = 8;
  const padR = 78;
  const padT = 14;
  const padB = 12;
  const N = 32;

  // Mulberry32-style seeded PRNG. Bucket APY to 0.01% so trivial recompute
  // differences don't reshuffle the walk.
  const seed = Math.max(1, Math.floor(apy * 100));
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 10_000) / 10_000;
  };

  // Generate the walk in APY-space ±15%, then map to viewbox.
  const band = apy * 0.15 + 0.5; // small floor for very-low-APY markets
  const series: number[] = [];
  let v = apy;
  for (let i = 0; i < N; i++) {
    const step = (rand() - 0.5) * band * 0.4;
    v = v + step;
    // soft re-center so it doesn't drift to infinity
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
      {/* mid-line at current APY */}
      <line
        x1={padL}
        y1={y(apy)}
        x2={W - padR}
        y2={y(apy)}
        stroke="currentColor"
        strokeOpacity={0.18}
        strokeDasharray="2 3"
      />
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
  onPick,
}: {
  detail: MarketDetail;
  onPick: (s: PickStrategy) => void;
}) {
  // bigint → Number for ratio math. Both fit comfortably in 2^53 for any
  // realistic pool size; we're only computing a fraction in [0, 1].
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

      {/* LP path isn't wired through TradeCard yet — we hand off to "split" as
          a placeholder so the user still sees a related flow. Phase 3 will
          add a proper "Add liquidity" path (mint LP via market.mint) and the
          route handler that scrolls there. */}
      <Cta onClick={() => onPick("split")}>Open LP →</Cta>
    </CardShell>
  );
}

/**
 * Two-arc donut. PT in `text-text`, SY in `text-textDim`. Stroke-based
 * (no fill) for the clean Pendle-y look. When the pool has no composition
 * yet (both reserves 0) we render an empty stroked circle.
 *
 * 72×72 viewbox, r=28, stroke=8. Start angle at the top (-90°).
 */
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
        {/* PT arc (text-text) */}
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
        {/* SY arc (text-textDim), offset to start where PT ends */}
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
