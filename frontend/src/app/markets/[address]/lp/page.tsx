"use client";

/**
 * Provide LP sub-page — pool composition + Add/Remove LP form.
 */
import { MarketSubPageShell } from "@/components/MarketSubPageShell";
import { ProvideLpForm } from "@/components/forms/ProvideLpForm";
import { AssociationGate } from "@/components/AssociationGate";
import type { MarketDetail } from "@/hooks/useMarket";

export default function LpPage({ params }: { params: Promise<{ address: string }> }) {
  return (
    <MarketSubPageShell
      params={params}
      crumb="Provide LP"
      renderEconomics={(detail) => <LpEconomics detail={detail} />}
      renderTradeForm={({ detail, user, market, syBalance }) => (
        <AssociationGate
          requiredTokens={[detail.lp]}
          tokenLabels={["LP share token"]}
          reason="needed to receive LP shares when you add liquidity"
        >
          <ProvideLpForm market={market} detail={detail} user={user} syBalance={syBalance} />
        </AssociationGate>
      )}
    />
  );
}

function LpEconomics({ detail }: { detail: MarketDetail }) {
  const totalPt = Number(detail.totalPt);
  const totalSy = Number(detail.totalSy);
  const sum = totalPt + totalSy;
  const ptShare = sum > 0 ? totalPt / sum : 0.5;
  const syShare = sum > 0 ? totalSy / sum : 0.5;
  const hasComposition = sum > 0;

  return (
    <div>
      <h2 className="text-[18px] font-semibold tracking-tight text-text">Provide Liquidity</h2>

      <div className="mt-4 rounded-xl border border-border bg-white/[0.02] px-4 py-3">
        <div className="text-[10px] uppercase tracking-[1.5px] text-textDim">
          Pool composition
        </div>
        <div className="mt-1 font-mono text-[20px] font-bold text-text">
          {hasComposition ? `${(ptShare * 100).toFixed(1)}% PT / ${(syShare * 100).toFixed(1)}% SY` : "—"}
        </div>
        <div className="mt-0.5 text-[12px] text-textSec">
          {/* TODO: 24h volume isn't indexed yet; show "—" once the indexer ships. */}
          24h volume: <span className="font-mono text-textDim">—</span>
        </div>
      </div>

      <div className="mt-5">
        <LpDonutBig ptShare={ptShare} syShare={syShare} hasComposition={hasComposition} />
      </div>

      <ol className="mt-5 space-y-3 text-[13px] leading-relaxed text-textSec">
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            1
          </span>
          <span>Deposit SY + PT in proportion to the current pool ratio.</span>
        </li>
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            2
          </span>
          <span>
            Earn LP shares (fLP-rwd) that accrue ~50% of trading fees + protocol rewards over the term.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            3
          </span>
          <span>Withdraw anytime via the Remove Liquidity tab — the AMM is open until expiry.</span>
        </li>
      </ol>

      <div className="mt-5 rounded-xl border border-textDim/30 bg-white/[0.02] px-4 py-3 text-[12px] leading-relaxed text-textSec">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1.5px] text-textDim">
          Math
        </div>
        Pool earns from PT↔SY swap fees. The more AMM volume the higher the LP yield.
        Composition shifts toward whichever side traders demand more of, so your SY/PT
        mix at withdrawal won&apos;t exactly match deposit.
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[1.5px] text-textDim">
          Risks
        </div>
        <ul className="space-y-1.5 text-[12px] leading-relaxed text-textSec">
          <li>
            Impermanent-loss-style exposure — your SY+PT mix shifts as the AMM trades; you exit at a different
            ratio than you entered.
          </li>
          <li>
            LP token is HTS — you must associate the LP token before adding liquidity. The page handles this
            once per wallet.
          </li>
          <li>
            Expiry doesn&apos;t dissolve LP — you must remove liquidity manually after expiry to recover SY + PT
            (PT then redeems 1:1 for SY).
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Larger LP composition donut for the sub-page.
 */
function LpDonutBig({
  ptShare,
  syShare,
  hasComposition,
}: {
  ptShare: number;
  syShare: number;
  hasComposition: boolean;
}) {
  const size = 200;
  const r = 80;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const ptLen = circ * ptShare;
  const syLen = circ * syShare;

  return (
    <div className="flex items-center gap-6">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-[200px] w-[200px]" role="img" aria-label="Pool composition donut">
        {hasComposition ? (
          <g transform={`rotate(-90 ${cx} ${cy})`}>
            <circle
              className="text-text"
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={22}
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
              strokeWidth={22}
              strokeDasharray={`${syLen} ${circ - syLen}`}
              strokeDashoffset={-ptLen}
              strokeLinecap="butt"
            />
          </g>
        ) : (
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={22} />
        )}
      </svg>
      <div className="flex flex-col gap-3">
        <Legend label="PT" pct={hasComposition ? ptShare * 100 : null} swatch="bg-text" />
        <Legend label="SY" pct={hasComposition ? syShare * 100 : null} swatch="bg-textDim" />
      </div>
    </div>
  );
}

function Legend({ label, pct, swatch }: { label: string; pct: number | null; swatch: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`inline-block h-3 w-3 rounded-sm ${swatch}`} />
      <span className="text-[13px] text-textSec">
        {label} <span className="font-mono text-text">{pct !== null ? `${pct.toFixed(1)}%` : "—"}</span>
      </span>
    </div>
  );
}
