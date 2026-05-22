"use client";

/**
 * SellYtForm — exit a YT position pre-expiry by calling
 * `FissionMarket.swapExactYtForSy` directly on the Market. YT is freeze-by-
 * default and cannot be transferred to a Router, so the Market itself handles
 * the YT wipe + paired PT burn + SY payout in one atomic call.
 *
 * No approval step — the Market uses its WIPE key to destroy `ytIn` YT from
 * the caller. The user just signs the swap call.
 *
 * Post-expiry, YT has no SY claim in the rewards market (only PT redeems),
 * so the form auto-disables and points users to the residual-rewards-claim
 * path.
 */
import { useCallback, useMemo, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ytToSyRate } from "@/components/MarketPositionCard";
import { useSyValueUsd } from "@/hooks/useSyValueUsd";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { computeSizeLimit, MAX_TRADE_PCT_OF_POOL } from "@/lib/trade-limits";
import { FlowOfFunds, type FlowStep } from "@/components/FlowOfFunds";
import {
  FormHeaderStrip,
  MoneyInput,
  parseRawBigInt,
  SectionDivider,
  SlippageChips,
  StatusPill,
  usdToRawBigInt,
} from "./_primitives";

interface Props {
  market: `0x${string}`;
  detail: MarketDetail;
  user: `0x${string}` | undefined;
}

type FlowKind =
  | { kind: "idle" }
  | { kind: "selling" }
  | { kind: "done"; finalTxHash: string }
  | { kind: "error"; message: string };

export function SellYtForm({ market, detail, user }: Props) {
  const adapter = useWalletAdapter();
  const { usdPerShare } = useSyValueUsd(detail.sy);

  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [rawStr, setRawStr] = useState("");
  // 500 bps (5%) default — the AMM's Pendle V2 curve doesn't match the
  // frontend's simple-interest `1 - ptRate` estimate; the gap is small but
  // varies with pool state and ytPrice is small enough that any drift becomes
  // a large relative miss. Combined with the 0.95 estimate buffer below this
  // gives ~9.75% headroom under the model — enough to absorb pool drift
  // between page-render and tx-submit at any practical depth.
  const [slippageBps, setSlippageBps] = useState(500);

  const [flowState, setFlowState] = useState<FlowKind>({ kind: "idle" });
  const [lastTxHash, setLastTxHash] = useState<string | undefined>(undefined);
  const [writeError, setWriteError] = useState<string | null>(null);

  const useWagmiReceipt = adapter.mode === "evm";
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: useWagmiReceipt ? (lastTxHash as `0x${string}` | undefined) : undefined,
    query: { enabled: useWagmiReceipt && !!lastTxHash && lastTxHash.startsWith("0x") },
  });
  const isConfirmedFinal = useWagmiReceipt ? isConfirmed : !!lastTxHash;
  const isConfirmingFinal = useWagmiReceipt ? isConfirming : false;

  const expired = Date.now() / 1000 >= Number(detail.expiry);

  /* ─────────────────────────── YT balance via contract-tracked view */

  // Read from `market.ytBalanceOf(user)` — the contract-tracked balance that
  // works for Ed25519 wallets too. (HTS facade `IERC20(yt).balanceOf` reverts
  // for long-zero EVM addresses of Ed25519 HAPI accounts.)
  const ytRead = useReadContracts({
    contracts: user
      ? [
          {
            abi: [
              {
                type: "function",
                name: "ytBalanceOf",
                stateMutability: "view",
                inputs: [{ name: "user", type: "address" }],
                outputs: [{ type: "uint256" }],
              },
            ] as const,
            address: market,
            functionName: "ytBalanceOf",
            args: [user],
          } as const,
        ]
      : [],
    query: { enabled: !!user },
    allowFailure: true,
  });
  const ytBalance =
    ytRead.data?.[0]?.status === "success" ? (ytRead.data[0].result as bigint) : 0n;
  // Detect a transient read failure (Hashio cache hiccup, RPC drop) so the
  // form doesn't dead-lock with "Insufficient YT — you have 0" while the user
  // actually holds a YT position. Same pattern as SellPtForm's Ed25519 guard.
  const ytBalanceReadFailed =
    ytRead.data?.[0]?.status === "failure" ||
    (ytRead.isError && ytBalance === 0n);

  /* ─────────────────────────── parsed input */

  // YT price (SY per 1 YT) = 1 - PT price. Used for USD↔raw conversion.
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ytPrice = ytToSyRate(apy, days);
  const usdPerYt =
    usdPerShare !== undefined && ytPrice > 0 ? usdPerShare * ytPrice : undefined;

  const parsedYt = useMemo<bigint>(() => {
    if (inputMode === "usd" && usdPerYt !== undefined) {
      return usdToRawBigInt(usdStr, usdPerYt);
    }
    return parseRawBigInt(rawStr);
  }, [inputMode, usdStr, rawStr, usdPerYt]);

  // Skip the local "insufficient" gate when the on-chain read failed — the
  // contract's own `_ytBal[msg.sender] < ytIn` check will revert authoritatively
  // if the user actually doesn't have enough YT.
  const insufficient = !ytBalanceReadFailed && parsedYt > ytBalance;
  // Sell YT depletes the AMM's PT inventory (PT is burned) → limit on totalPt.
  const sizeLimit = computeSizeLimit(parsedYt, detail.totalPt, detail.totalSy);

  /* ─────────────────────────── SY estimate + slippage floor */

  // Linear approximation: syOut ≈ ytIn × (1 - ptRate). The contract recomputes
  // the exact figure via the AMM curve and reverts if it falls below minSyOut.
  // Pre-shrink the estimate by 5% to absorb the simple-interest vs AMM-curve
  // model drift on the YT side — empirical reverts at 1% buffer + 1.5%
  // slippage showed the actual curve was ~0.16% below the form's minSyOut,
  // so we lean harder on the buffer instead of trusting the linear model.
  const syEstimateNum =
    parsedYt > 0n && ytPrice > 0 ? Number(parsedYt) * ytPrice * 0.95 : 0;
  const syEstimate = syEstimateNum > 0 ? BigInt(Math.floor(syEstimateNum)) : 0n;
  const minSyOut = (syEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

  /* ─────────────────────────── primary handler */

  const onPrimary = useCallback(async () => {
    if (!user || parsedYt === 0n || expired) return;
    if (insufficient || sizeLimit.exceeded) return;
    setWriteError(null);
    setFlowState({ kind: "selling" });
    try {
      const { txHash } = await adapter.write({
        kind: "swapExactYtForSy",
        market,
        ytIn: parsedYt,
        minSyOut,
        receiver: user,
      });
      setLastTxHash(txHash);
      setFlowState({ kind: "done", finalTxHash: txHash });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg });
    }
  }, [adapter, expired, insufficient, market, minSyOut, parsedYt, sizeLimit.exceeded, user]);

  const isPending = adapter.isWritePending || flowState.kind === "selling";
  const isDoneFinal = flowState.kind === "done";

  /* ─────────────────────────── FlowOfFunds */

  const flowSteps: FlowStep[] = [
    {
      label: "You sell",
      detail: "Connected wallet → Market (wipe)",
      inToken:
        parsedYt > 0n
          ? {
              sym: "YT",
              amount: formatCompact(parsedYt),
              usd:
                usdPerYt !== undefined
                  ? `≈ $${(Number(parsedYt) * usdPerYt).toFixed(2)}`
                  : undefined,
            }
          : undefined,
      isComplete: isDoneFinal,
    },
    {
      label: "Fission Market",
      detail: `wipe YT · burn pool PT · swapExactYtForSy`,
      isActive: isPending && !isDoneFinal,
      isComplete: isDoneFinal,
    },
    {
      label: "SY delivered",
      detail: `≤ ${(slippageBps / 100).toFixed(2)}% slippage`,
      outToken:
        syEstimate > 0n
          ? {
              sym: "SY",
              amount: `~${formatCompact(syEstimate)}`,
              usd: `min ${formatCompact(minSyOut)} SY`,
            }
          : undefined,
      isComplete: isDoneFinal,
    },
    {
      label: "Your wallet",
      detail: user ? shortAddr(user) : "—",
      isComplete: isDoneFinal,
    },
  ];

  /* ─────────────────────────── button label */

  const buttonLabel = (): string => {
    if (!user) return "Connect wallet";
    if (expired) return "Market expired — YT has no SY claim";
    if (parsedYt === 0n) return "Enter amount";
    if (insufficient) return "Insufficient YT";
    if (sizeLimit.exceeded) return "Trade too large for pool";
    if (flowState.kind === "error") return "Retry sell";
    if (flowState.kind === "selling") return "Selling YT…";
    if (flowState.kind === "done") return "✓ Done";
    if (isConfirmingFinal) return "Waiting for confirmation…";
    return "Sell YT";
  };

  const buttonDisabled =
    !user ||
    isPending ||
    isConfirmingFinal ||
    expired ||
    parsedYt === 0n ||
    insufficient ||
    sizeLimit.exceeded;

  const poolHealthy = !sizeLimit.exceeded && sizeLimit.poolDepth > 0n;

  return (
    <div className="flex flex-col gap-3">
      <FlowOfFunds title="Flow of funds · Sell YT" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Sell YT"
          right={
            <>
              {usdPerShare === undefined && (
                <StatusPill tone="info">Price loading</StatusPill>
              )}
              {poolHealthy ? (
                <StatusPill tone="success">Pool ok</StatusPill>
              ) : (
                <StatusPill tone="warning">Thin pool</StatusPill>
              )}
              <StatusPill tone="neutral">{MAX_TRADE_PCT_OF_POOL}% limit</StatusPill>
            </>
          }
        />

        {expired && (
          <div className="mb-3 rounded-[6px] border border-warning/30 bg-warning/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-warning">
            Market expired — YT has no SY claim in this market. Hold and claim
            any residual rewards instead.
          </div>
        )}

        <SectionDivider label="Input" />

        <MoneyInput
          mode={inputMode}
          setMode={setInputMode}
          usdStr={usdStr}
          setUsdStr={setUsdStr}
          rawStr={rawStr}
          setRawStr={setRawStr}
          parsedRaw={parsedYt}
          balance={ytBalance}
          tokenSym="YT"
          label="You sell"
          usdPerUnit={usdPerYt}
          formatRaw={formatCompact}
          insufficient={insufficient}
          outputHint={
            syEstimate > 0n ? (
              <span>
                Receiving <span className="text-text">~{formatCompact(syEstimate)} SY</span>
              </span>
            ) : undefined
          }
          minOutHint={
            syEstimate > 0n ? (
              <span>
                Min received <span className="text-text">{formatCompact(minSyOut)} SY</span>
              </span>
            ) : undefined
          }
          caption={
            <>
              Pool depth: {formatCompact(sizeLimit.poolDepth)} · max trade{" "}
              {MAX_TRADE_PCT_OF_POOL}% = {formatCompact(sizeLimit.maxAllowed)}
              {" · "}gas ~0.12 HBAR
            </>
          }
          feedback={
            insufficient ? (
              <span className="block font-mono text-[10px] font-medium text-error">
                Insufficient YT — you have {formatCompact(ytBalance)}.
              </span>
            ) : ytBalanceReadFailed ? (
              <span className="block font-mono text-[10px] font-medium text-warning">
                YT balance read failed — your tx will revert on-chain if you
                don&apos;t actually hold this YT.
              </span>
            ) : sizeLimit.message ? (
              <span className="block font-mono text-[10px] font-medium text-warning">
                {sizeLimit.message}
              </span>
            ) : null
          }
        />

        <SectionDivider label="Routing" />

        <SlippageChips
          slippageBps={slippageBps}
          setSlippageBps={setSlippageBps}
          maxBps={100}
        />

        <SectionDivider label="Settlement" />

        <button
          type="button"
          disabled={buttonDisabled}
          onClick={() => void onPrimary()}
          className="w-full rounded-[10px] bg-white px-7 py-3.5 font-mono text-sm font-semibold uppercase tracking-[1px] text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {buttonLabel()}
        </button>

        <p className="mt-2 font-mono text-[10px] leading-relaxed text-textDim">
          No approval needed — the Market holds the WIPE key on YT and consumes
          your balance directly.
        </p>

        {writeError && (
          <div className="mt-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-error">
            {writeError.slice(0, 240)}
          </div>
        )}

        {flowState.kind === "done" && lastTxHash && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-success">
            <div className="font-semibold uppercase tracking-[1px]">YT sold for SY.</div>
            <div className="mt-1 break-all text-[10px] text-success/80">
              tx: {lastTxHash.slice(0, 18)}…{lastTxHash.slice(-8)}
            </div>
            <div className="mt-1.5 flex gap-3">
              <a
                href={`https://hashscan.io/mainnet/transaction/${lastTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-text"
              >
                View on HashScan
              </a>
              <button
                type="button"
                onClick={() => {
                  setFlowState({ kind: "idle" });
                  setLastTxHash(undefined);
                  setWriteError(null);
                  setUsdStr("");
                  setRawStr("");
                  void ytRead.refetch();
                }}
                className="underline underline-offset-2 hover:text-text"
              >
                New trade
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
