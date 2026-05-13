"use client";

/**
 * FlowOfFunds — vertical stepped diagram that visualizes where the user's
 * money goes during a deposit/trade. Used inline above the trade forms on the
 * /markets/[address]/{pt,yt,lp} sub-pages and the inline mint flow.
 *
 * Each step renders as a single row:
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ ● Step label                          inToken → outToken  │
 *   │ │ detail caption                                          │
 *   ├───┴───────────────────────────────────────────────────────┤
 *   │ ● next step…                                              │
 *   └───────────────────────────────────────────────────────────┘
 *
 * The component is purely presentational — it knows nothing about the form
 * state; each form computes its own `FlowStep[]` from the user's inputs and
 * passes them in. That keeps the per-flow conditional logic (HBAR zap fee,
 * proportional add-liquidity, etc.) inside the form where it belongs.
 *
 * Visual language:
 *   • Mono everywhere — terminal/console aesthetic
 *   • Subtle dot-grid background (CSS radial gradient)
 *   • Thin dashed connector line between rows
 *   • `isActive`: pulsing green dot — currently-executing step
 *   • `isComplete`: solid green dot
 *   • Inactive: dim grey dot
 */

import { type ReactNode } from "react";

/* ─────────────────────────────────────────────────────── types */

export interface FlowToken {
  /** Token symbol shown in the in/out column. */
  sym: string;
  /** Human-readable amount, e.g. "5.00", "~16.3M", "≈ 16,000,000". */
  amount: string;
  /** Optional `≈ $X.XX` USD hint, rendered dim under the amount. */
  usd?: string;
}

export interface FlowStep {
  /** Bold left-column label, e.g. "Zap contract" or "SY mint". */
  label: string;
  /** Dim caption underneath the label. Use for short notes (fee, account id). */
  detail?: string;
  /** What flows IN to this step. */
  inToken?: FlowToken;
  /** What flows OUT of this step. */
  outToken?: FlowToken;
  /** Pulsing green dot — the step currently being signed/awaited. */
  isActive?: boolean;
  /** Solid green dot — step has settled. */
  isComplete?: boolean;
}

interface Props {
  /** Optional title pinned to the top-left of the flow card. */
  title?: string;
  /** Optional right-side pill rendered next to the title (e.g. "1 TX"). */
  badge?: ReactNode;
  steps: FlowStep[];
}

/* ─────────────────────────────────────────────────────── component */

export function FlowOfFunds({ title = "Flow of funds", badge, steps }: Props) {
  return (
    <div
      className="rounded-2xl border border-border bg-bgCard p-4"
      style={{
        // Subtle dot grid behind the flow. Two stacked radial-gradients give
        // an 8px square pattern of dim white dots. Pure CSS — no SVG cost.
        backgroundImage:
          "radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)",
        backgroundSize: "12px 12px",
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
          <span aria-hidden className="text-success">▾</span>
          <span>{title}</span>
        </div>
        {badge}
      </div>

      <ol className="relative" role="list">
        {steps.map((step, idx) => {
          const isLast = idx === steps.length - 1;
          const dotColor = step.isActive
            ? "bg-success animate-pulse"
            : step.isComplete
              ? "bg-success"
              : "bg-textDim/40";
          const dotRing = step.isActive
            ? "ring-2 ring-success/30"
            : step.isComplete
              ? "ring-1 ring-success/30"
              : "";
          return (
            <li key={`${step.label}-${idx}`} className="relative pl-6 pb-3 last:pb-0">
              {/* Connector line — dashed, dimmed, hides on the last row. */}
              {!isLast && (
                <span
                  aria-hidden
                  className="absolute left-[7px] top-3 bottom-0 w-px border-l border-dashed border-border"
                />
              )}
              {/* Dot. */}
              <span
                aria-hidden
                className={`absolute left-[3px] top-[5px] block h-2 w-2 rounded-full ${dotColor} ${dotRing}`}
              />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div
                    className={`font-mono text-[12px] font-medium leading-tight ${
                      step.isActive
                        ? "text-success"
                        : step.isComplete
                          ? "text-success/90"
                          : "text-text"
                    }`}
                  >
                    {step.label}
                  </div>
                  {step.detail && (
                    <div className="mt-0.5 font-mono text-[10px] leading-tight text-textDim">
                      {step.detail}
                    </div>
                  )}
                </div>
                {(step.inToken || step.outToken) && (
                  <div className="flex flex-shrink-0 flex-col items-end gap-0.5 text-right">
                    {step.inToken && step.outToken ? (
                      <FlowSwap inTok={step.inToken} outTok={step.outToken} />
                    ) : step.outToken ? (
                      <FlowAmount tok={step.outToken} />
                    ) : step.inToken ? (
                      <FlowAmount tok={step.inToken} />
                    ) : null}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── helpers */

function FlowAmount({ tok }: { tok: FlowToken }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className="font-mono text-[11px] text-text"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {tok.amount} <span className="text-textDim">{tok.sym}</span>
      </span>
      {tok.usd && (
        <span
          className="font-mono text-[9px] text-textDim"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {tok.usd}
        </span>
      )}
    </div>
  );
}

function FlowSwap({ inTok, outTok }: { inTok: FlowToken; outTok: FlowToken }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div
        className="flex items-baseline gap-1.5 font-mono text-[11px] text-text"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        <span>
          {inTok.amount} <span className="text-textDim">{inTok.sym}</span>
        </span>
        <span aria-hidden className="text-textDim">→</span>
        <span>
          {outTok.amount} <span className="text-textDim">{outTok.sym}</span>
        </span>
      </div>
      {(inTok.usd || outTok.usd) && (
        <span
          className="font-mono text-[9px] text-textDim"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {outTok.usd ?? inTok.usd}
        </span>
      )}
    </div>
  );
}
