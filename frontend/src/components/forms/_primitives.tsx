"use client";

/**
 * Shared UI primitives for the trade forms — slippage chips, status pills,
 * section dividers, and the USD-denominated input. Pulled out so all four
 * forms (BuyPt, BuyYt, MintSy, ProvideLp) render identically.
 *
 * Nothing in here knows about wagmi / wallet / contracts — pure presentation.
 */

import { useState, type ReactNode } from "react";

/* ─────────────────────────────────────────────────────── section divider */

/**
 * Thin dashed divider with a small uppercase mono label, e.g.:
 *
 *     ── INPUT ──────────────────────────
 *
 * Used to demarcate the input / routing / settlement sections inside a form.
 */
export function SectionDivider({ label }: { label: string }) {
  return (
    <div className="my-3 flex items-center gap-2 text-textDim">
      <span
        aria-hidden
        className="flex-shrink-0 border-t border-dashed border-border"
        style={{ width: 12 }}
      />
      <span className="font-mono text-[9px] uppercase tracking-[2px]">{label}</span>
      <span
        aria-hidden
        className="h-px flex-1 border-t border-dashed border-border"
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────── status pill */

export type PillTone = "neutral" | "success" | "warning" | "error" | "info";

/**
 * Status pill, mono-cased and bracketed for the terminal feel:
 *
 *   [POOL HEALTHY]   (success)
 *   [NEEDS APPROVAL] (warning)
 *   [DISCONNECTED]   (error)
 */
export function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: PillTone;
  children: ReactNode;
}) {
  const cls = {
    neutral: "border-border bg-white/[0.03] text-textDim",
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-warning",
    error: "border-error/30 bg-error/10 text-error",
    info: "border-accent/30 bg-accent/10 text-accent",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1.5px] ${cls}`}
    >
      [{children}]
    </span>
  );
}

/* ─────────────────────────────────────────────────────── form header strip */

/**
 * Terminal-style strip at the top of a trade form: name on the left, optional
 * version chip on the right. Lives directly under the rounded card border.
 */
export function FormHeaderStrip({
  name,
  version = "v1",
  right,
}: {
  name: string;
  version?: string;
  right?: ReactNode;
}) {
  return (
    <div className="-mx-4 -mt-4 mb-3 flex items-center justify-between border-b border-border bg-white/[0.02] px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[2px] text-textSec">
          {name}
        </span>
        <span className="rounded-[3px] border border-border px-1 py-0.5 font-mono text-[8px] uppercase tracking-[1.5px] text-textDim">
          {version}
        </span>
      </div>
      <div className="flex items-center gap-1.5">{right}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── slippage chips */

const SLIPPAGE_PRESETS = [10, 50, 100] as const; // bps: 0.10% / 0.50% / 1.00%

/**
 * Replaces the slippage <input type=range> with three chip presets +
 * an inline custom box. Capped at 1.00 % (per the safety guardrail).
 *
 * `slippageBps` is the canonical state (bps integer). Custom decimal entry
 * is parsed back into bps under the hood.
 */
export function SlippageChips({
  slippageBps,
  setSlippageBps,
  maxBps = 100,
}: {
  slippageBps: number;
  setSlippageBps: (n: number) => void;
  maxBps?: number;
}) {
  const isPreset = SLIPPAGE_PRESETS.includes(slippageBps as 10 | 50 | 100);
  const [customStr, setCustomStr] = useState<string>(() =>
    isPreset ? "" : (slippageBps / 100).toFixed(2),
  );

  const onCustomChange = (v: string) => {
    setCustomStr(v);
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return;
    const bps = Math.round(n * 100);
    // Clamp to [5, maxBps]. 0.05 % is the floor — anything tighter than
    // the AMM's effective resolution just guarantees a revert.
    const clamped = Math.max(5, Math.min(maxBps, bps));
    setSlippageBps(clamped);
  };

  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-textDim">
          Slippage
        </span>
        <span
          className="font-mono text-[10px] text-textSec"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {(slippageBps / 100).toFixed(2)}%
        </span>
      </div>
      <div className="flex items-stretch gap-1.5">
        {SLIPPAGE_PRESETS.map((bps) => {
          const isActive = slippageBps === bps && !customStr;
          return (
            <button
              key={bps}
              type="button"
              onClick={() => {
                setCustomStr("");
                setSlippageBps(bps);
              }}
              className={`flex-1 rounded-[6px] border px-2 py-1.5 font-mono text-[11px] tabular-nums transition ${
                isActive
                  ? "border-text/60 bg-white/[0.08] text-text"
                  : "border-border bg-bgInput text-textSec hover:border-borderHover hover:text-text"
              }`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {(bps / 100).toFixed(bps < 100 ? 2 : 1)}%
            </button>
          );
        })}
        <div
          className={`flex flex-1 items-center gap-1 rounded-[6px] border px-2 py-1.5 font-mono text-[11px] transition ${
            customStr
              ? "border-text/60 bg-white/[0.08]"
              : "border-border bg-bgInput"
          }`}
        >
          <input
            type="number"
            inputMode="decimal"
            value={customStr}
            onChange={(e) => onCustomChange(e.target.value)}
            placeholder="custom"
            className="w-full bg-transparent text-text outline-none placeholder:text-textDim"
            min={0.05}
            max={maxBps / 100}
            step={0.01}
            style={{ fontVariantNumeric: "tabular-nums" }}
          />
          {customStr && <span className="text-textDim">%</span>}
        </div>
      </div>
      <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-textDim">
        {maxBps}% cap · 1% pool-size limit keeps actual slippage well under tolerance.
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── USD input */

/**
 * USD-denominated input. The user types dollars, and we surface the
 * equivalent raw token count underneath. Falls back to a raw-amount input
 * mode when `usdPerUnit` is undefined (price feed loading or unsupported SY).
 *
 * The `mode` is driven by the parent: when in `usd` mode the parent stores
 * the dollar string and converts to bigint; when `raw` it stores the raw
 * bigint string directly. We keep state lifted so the parent owns the
 * source-of-truth for tx submission.
 */
interface MoneyInputProps {
  /** Currently-selected input mode ("usd" requires a price feed). */
  mode: "usd" | "raw";
  setMode: (m: "usd" | "raw") => void;
  /** USD-denominated user input string (when mode === "usd"). */
  usdStr: string;
  setUsdStr: (v: string) => void;
  /** Raw-bigint user input string (when mode === "raw"). */
  rawStr: string;
  setRawStr: (v: string) => void;
  /** Computed raw bigint regardless of mode — for "≈" display + max button. */
  parsedRaw: bigint;
  /** Token-side balance in raw units, for the MAX button + balance hint. */
  balance: bigint;
  /** Token symbol shown after the equivalence line. */
  tokenSym: string;
  /** Optional secondary line: what they're buying with this. */
  outputHint?: ReactNode;
  /** Optional "Min received" floor line. */
  minOutHint?: ReactNode;
  /** Token-amount formatter (e.g. `formatCompact` for raw shares). */
  formatRaw: (v: bigint) => string;
  /** $/raw-unit. Required for `usd` mode; when undefined, we force raw mode. */
  usdPerUnit: number | undefined;
  /** Optional caption shown beneath the input (pool depth, etc.). */
  caption?: ReactNode;
  /** Error / warning slot under the input. */
  feedback?: ReactNode;
  /** Indicates user has typed something we treat as insufficient. */
  insufficient?: boolean;
  /** Optional left-hand label, e.g. "You pay" / "Deposit". */
  label?: string;
}

export function MoneyInput({
  mode,
  setMode,
  usdStr,
  setUsdStr,
  rawStr,
  setRawStr,
  parsedRaw,
  balance,
  tokenSym,
  outputHint,
  minOutHint,
  formatRaw,
  usdPerUnit,
  caption,
  feedback,
  insufficient,
  label,
}: MoneyInputProps) {
  // Force raw mode if no price feed.
  const effectiveMode = usdPerUnit === undefined ? "raw" : mode;
  const balanceUsd =
    usdPerUnit !== undefined ? Number(balance) * usdPerUnit : undefined;

  const setMaxUsd = () => {
    if (balanceUsd === undefined) return;
    // Round down two decimals so we never exceed the user's actual balance.
    const rounded = Math.floor(balanceUsd * 100) / 100;
    setUsdStr(rounded.toFixed(2));
  };
  const setMaxRaw = () => setRawStr(balance.toString());

  return (
    <label className="mb-3 block">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-textDim">
          {label ?? "You pay"}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setMode("usd")}
            disabled={usdPerUnit === undefined}
            className={`rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] transition disabled:opacity-30 ${
              effectiveMode === "usd"
                ? "border-text/60 bg-white/[0.08] text-text"
                : "border-border bg-bgInput text-textDim hover:text-text"
            }`}
          >
            USD
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={`rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] transition ${
              effectiveMode === "raw"
                ? "border-text/60 bg-white/[0.08] text-text"
                : "border-border bg-bgInput text-textDim hover:text-text"
            }`}
          >
            {tokenSym}
          </button>
        </div>
      </div>

      <div
        className={`flex items-stretch rounded-[10px] border bg-bgInput transition ${
          insufficient
            ? "border-error/60 focus-within:border-error"
            : "border-border focus-within:border-borderHover"
        }`}
      >
        {effectiveMode === "usd" && (
          <span className="flex items-center pl-3 font-mono text-base text-textDim">
            $
          </span>
        )}
        <input
          type="number"
          inputMode="decimal"
          value={effectiveMode === "usd" ? usdStr : rawStr}
          onChange={(e) =>
            effectiveMode === "usd" ? setUsdStr(e.target.value) : setRawStr(e.target.value)
          }
          placeholder={effectiveMode === "usd" ? "0.00" : "0"}
          className="w-full bg-transparent px-3 py-3.5 font-mono text-base text-text outline-none"
          style={{ fontVariantNumeric: "tabular-nums" }}
        />
        <button
          type="button"
          onClick={effectiveMode === "usd" ? setMaxUsd : setMaxRaw}
          disabled={balance === 0n || (effectiveMode === "usd" && balanceUsd === undefined)}
          className="mr-2 my-1.5 rounded border border-borderHover bg-white/[0.04] px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-30"
        >
          Max
        </button>
      </div>

      {/* Balance + equivalence row */}
      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-textDim">
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {effectiveMode === "usd" && parsedRaw > 0n && usdPerUnit !== undefined ? (
            <>≈ {formatRaw(parsedRaw)} {tokenSym}</>
          ) : effectiveMode === "raw" && parsedRaw > 0n && usdPerUnit !== undefined ? (
            <>≈ ${(Number(parsedRaw) * usdPerUnit).toFixed(2)}</>
          ) : usdPerUnit === undefined ? (
            <span className="text-textDim">price loading…</span>
          ) : (
            <>&nbsp;</>
          )}
        </span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          Bal: {formatRaw(balance)}
          {balanceUsd !== undefined && balance > 0n && (
            <span className="ml-1 text-textDim">(${balanceUsd.toFixed(2)})</span>
          )}
        </span>
      </div>

      {outputHint && (
        <div className="mt-1 font-mono text-[10px] text-textSec">{outputHint}</div>
      )}
      {minOutHint && (
        <div className="mt-0.5 font-mono text-[10px] text-textDim">{minOutHint}</div>
      )}
      {caption && (
        <div className="mt-1 font-mono text-[10px] leading-relaxed text-textDim">
          {caption}
        </div>
      )}
      {feedback && <div className="mt-1.5">{feedback}</div>}
    </label>
  );
}

/* ─────────────────────────────────────────────────────── helpers */

/**
 * Convert a user-typed dollar string into a raw token bigint, given a
 * $/raw-unit rate. Returns 0n on any unparseable input.
 *
 * We do the division in float space (Number) because the rate is already a
 * float — there's no precision benefit to BigInt-ifying the dollar amount
 * before the multiply. We then ceil to a whole raw unit (so we never under-
 * pay by sub-unit rounding) and cap at MAX_SAFE_INTEGER as a sanity guard.
 */
export function usdToRawBigInt(usdStr: string, usdPerUnit: number | undefined): bigint {
  if (!usdStr || usdPerUnit === undefined || usdPerUnit <= 0) return 0n;
  const usd = parseFloat(usdStr.replace(/,/g, ""));
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  const raw = Math.ceil(usd / usdPerUnit);
  if (raw <= 0) return 0n;
  if (raw > Number.MAX_SAFE_INTEGER) return BigInt(Number.MAX_SAFE_INTEGER);
  return BigInt(raw);
}

/**
 * Parse a raw bigint string. Matches the existing input contract used in the
 * pre-redesign forms (drops fractional digits because raw counts are whole).
 */
export function parseRawBigInt(s: string): bigint {
  try {
    if (!s) return 0n;
    const cleaned = s.trim().replace(/,/g, "");
    if (/^[0-9]+(\.0+)?$/.test(cleaned)) {
      return BigInt(cleaned.split(".")[0] ?? "0");
    }
    return 0n;
  } catch {
    return 0n;
  }
}
