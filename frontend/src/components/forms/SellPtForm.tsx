"use client";

/**
 * SellPtForm — exit a PT position pre-expiry by selling into the AMM. PT in,
 * SY back out. Uses `router.swapExactPtForSy` (contract has supported this
 * since v1; UI was missing until now).
 *
 * Same shell as BuyPtForm but unidirectional (PT only, no HBAR zap):
 *   1. Approve PT for Router (if allowance insufficient)
 *   2. Swap PT → SY
 *
 * Post-expiry, prefer `redeemAfterExpiry` (1:1) over swap — the AMM curve
 * pays slightly less than par. The form auto-disables in that case.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate } from "@/components/MarketPositionCard";
import { useSyValueUsd } from "@/hooks/useSyValueUsd";
import { ADDRESSES, isDeployed, MAX_HTS_APPROVE } from "@/lib/addresses";
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
  | { kind: "approving" }
  | { kind: "selling" }
  | { kind: "done"; finalTxHash: string }
  | { kind: "error"; message: string; failedAt: "approve" | "sell" };

export function SellPtForm({ market, detail, user }: Props) {
  const adapter = useWalletAdapter();
  const { usdPerShare } = useSyValueUsd(detail.sy);

  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [rawStr, setRawStr] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);

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

  const routerDeployed = isDeployed(ADDRESSES.router);
  const expired = Date.now() / 1000 >= Number(detail.expiry);

  /* ─────────────────────────── PT balance + allowance reads */

  const spender: `0x${string}` = ADDRESSES.router;
  const ptRead = useReadContracts({
    contracts: user
      ? [
          {
            abi: [
              {
                type: "function",
                name: "balanceOf",
                stateMutability: "view",
                inputs: [{ name: "owner", type: "address" }],
                outputs: [{ type: "uint256" }],
              },
            ] as const,
            address: detail.pt,
            functionName: "balanceOf",
            args: [user],
          } as const,
          {
            abi: [
              {
                type: "function",
                name: "allowance",
                stateMutability: "view",
                inputs: [
                  { name: "owner", type: "address" },
                  { name: "spender", type: "address" },
                ],
                outputs: [{ type: "uint256" }],
              },
            ] as const,
            address: detail.pt,
            functionName: "allowance",
            args: [user, spender],
          } as const,
        ]
      : [],
    query: { enabled: !!user },
    allowFailure: true,
  });
  const ptBalance =
    ptRead.data?.[0]?.status === "success" ? (ptRead.data[0].result as bigint) : 0n;
  const allowance =
    ptRead.data?.[1]?.status === "success" ? (ptRead.data[1].result as bigint) : 0n;
  // Ed25519 long-zero EVM addresses cause HTS-facade balanceOf to revert. Detect
  // that case so the "insufficient balance" gate doesn't dead-lock the form for
  // an Ed25519 user who actually holds PT. When the read failed, we skip the
  // local insufficiency check and let the on-chain transferFrom revert if the
  // user genuinely doesn't have the funds.
  const ptBalanceReadFailed = ptRead.data?.[0]?.status === "failure";

  /* ─────────────────────────── parsed input */

  // PT trades AT a discount to SY pre-expiry → for the USD<->raw conversion
  // we use the PT-implied SY-rate so the input feels honest ($X in PT, not
  // a phantom $X in SY-equivalent). `ptRate` here means "1 PT = `ptRate` SY".
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ptRate = ptToSyRate(apy, days);
  const usdPerPt =
    usdPerShare !== undefined && ptRate > 0 ? usdPerShare * ptRate : undefined;

  const parsedPt = useMemo<bigint>(() => {
    if (inputMode === "usd" && usdPerPt !== undefined) {
      return usdToRawBigInt(usdStr, usdPerPt);
    }
    return parseRawBigInt(rawStr);
  }, [inputMode, usdStr, rawStr, usdPerPt]);

  // Skip the local "insufficient" gate when the HTS facade read failed — see
  // `ptBalanceReadFailed` doc above. The on-chain swap reverts authoritatively
  // if the user actually doesn't hold enough PT.
  const insufficient = !ptBalanceReadFailed && parsedPt > ptBalance;
  // Limit governed by the AMM's SY side — selling PT means pulling SY out.
  const sizeLimit = computeSizeLimit(parsedPt, detail.totalPt, detail.totalSy);

  /* ─────────────────────────── SY estimate + slippage floor */

  // Estimated SY-out using the same linear approximation the other forms use
  // (real AMM has curvature; the on-chain `swapExactPtForSy` re-computes the
  // exact figure and reverts if it falls below `minSyOut`).
  const syEstimateNum =
    parsedPt > 0n && ptRate > 0 ? Number(parsedPt) * ptRate : 0;
  const syEstimate = syEstimateNum > 0 ? BigInt(Math.floor(syEstimateNum)) : 0n;
  const minSyOut = (syEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

  const needsApprove = parsedPt > 0n && allowance < parsedPt;

  /* ─────────────────────────── flow runners */

  const runApprove = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    setFlowState({ kind: "approving" });
    try {
      const { txHash } = await adapter.write({
        kind: "approveErc20",
        token: detail.pt,
        spender,
        // Set-once allowance: every future Sell PT skips the approve prompt.
        amount: MAX_HTS_APPROVE,
      });
      setLastTxHash(txHash);
      // In EVM mode, writeContractAsync returns on hash, NOT on receipt — the
      // immediate refetch can race the approve confirmation and the next sell
      // step would see stale allowance. Hedera-mode `executeWithSigner` already
      // waits for receipt internally. Either way, wait one mirror-lag cycle
      // before re-reading allowance so the AMM call sees the post-approve state.
      await new Promise((r) => setTimeout(r, adapter.mode === "evm" ? 3500 : 1500));
      await ptRead.refetch();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg, failedAt: "approve" });
      return false;
    }
  }, [adapter, detail.pt, parsedPt, ptRead, spender, user]);

  const runSell = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    setFlowState({ kind: "selling" });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    try {
      const { txHash } = await adapter.write({
        kind: "swapExactPtForSy",
        router: ADDRESSES.router,
        market,
        ptIn: parsedPt,
        minSyOut,
        receiver: user,
        deadline,
      });
      setLastTxHash(txHash);
      setFlowState({ kind: "done", finalTxHash: txHash });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg, failedAt: "sell" });
      return false;
    }
  }, [adapter, market, minSyOut, parsedPt, user]);

  // Re-entry guard against double-click after a successful sell (stale
  // form state would re-submit the same parsedPt before the balance read
  // refreshes). Synchronous via ref so it survives setIsPending flicker.
  const chainInFlight = useRef(false);
  const onPrimary = useCallback(async () => {
    if (chainInFlight.current) return;
    if (!user || parsedPt === 0n || !routerDeployed || expired) return;
    if (insufficient || sizeLimit.exceeded) return;
    chainInFlight.current = true;
    setWriteError(null);
    try {
      if (flowState.kind === "error") {
        // Resume from the failed step.
        if (flowState.failedAt === "approve") {
          const ok = await runApprove();
          if (!ok) return;
          const sellOk = await runSell();
          if (sellOk) {
            setUsdStr("");
            setRawStr("");
            void ptRead.refetch();
          }
        } else {
          const sellOk = await runSell();
          if (sellOk) {
            setUsdStr("");
            setRawStr("");
            void ptRead.refetch();
          }
        }
        return;
      }

      if (needsApprove) {
        const ok = await runApprove();
        if (!ok) return;
      }
      const sellOk = await runSell();
      if (sellOk) {
        setUsdStr("");
        setRawStr("");
        void ptRead.refetch();
      }
    } finally {
      chainInFlight.current = false;
    }
  }, [user, parsedPt, routerDeployed, expired, insufficient, sizeLimit.exceeded, flowState, needsApprove, runApprove, runSell, ptRead]);

  const isPending =
    adapter.isWritePending ||
    flowState.kind === "approving" ||
    flowState.kind === "selling";

  /* ─────────────────────────── FlowOfFunds */

  const isDoneFinal = flowState.kind === "done";
  const flowSteps: FlowStep[] = [
    {
      label: "You pay",
      detail: "Connected wallet → Router",
      inToken:
        parsedPt > 0n
          ? {
              sym: "PT",
              amount: formatCompact(parsedPt),
              usd:
                usdPerPt !== undefined
                  ? `≈ $${(Number(parsedPt) * usdPerPt).toFixed(2)}`
                  : undefined,
            }
          : undefined,
      isComplete: isDoneFinal,
    },
    {
      label: "Router",
      detail: shortAddr(ADDRESSES.router),
      isActive: isPending && !isDoneFinal,
      isComplete: isDoneFinal,
    },
    {
      label: "Fission AMM",
      detail: `swapExactPtForSy · ${apy.toFixed(2)}% impl APY`,
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
    if (expired) return "Market expired — redeem instead";
    if (parsedPt === 0n) return "Enter amount";
    if (insufficient) return "Insufficient PT";
    if (sizeLimit.exceeded) return "Trade too large for pool";
    if (flowState.kind === "error") {
      return flowState.failedAt === "approve" ? "Retry approval" : "Retry sell";
    }
    if (flowState.kind === "approving") return "Approving PT for Router…";
    if (flowState.kind === "selling") return "Selling PT…";
    if (flowState.kind === "done") return "✓ Done";
    if (isConfirmingFinal) return "Waiting for confirmation…";
    if (needsApprove) return "Approve PT for Router";
    return "Sell PT";
  };

  const buttonDisabled =
    !user ||
    isPending ||
    isConfirmingFinal ||
    !routerDeployed ||
    expired ||
    parsedPt === 0n ||
    insufficient ||
    sizeLimit.exceeded;

  const poolHealthy = !sizeLimit.exceeded && sizeLimit.poolDepth > 0n;

  return (
    <div className="flex flex-col gap-3">
      <FlowOfFunds title="Flow of funds · Sell PT" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Sell PT"
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
            Market expired — use <span className="text-text">Redeem</span> on the
            position page for 1:1 PT→SY. Selling on the AMM post-expiry pays less
            than par.
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
          parsedRaw={parsedPt}
          balance={ptBalance}
          tokenSym="PT"
          label="You sell"
          usdPerUnit={usdPerPt}
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
              {" · "}gas ~0.08 HBAR
            </>
          }
          feedback={
            insufficient ? (
              <span className="block font-mono text-[10px] font-medium text-error">
                Insufficient PT — you have {formatCompact(ptBalance)}.
              </span>
            ) : ptBalanceReadFailed ? (
              <span className="block font-mono text-[10px] font-medium text-warning">
                PT balance unavailable for this wallet (HTS facade quirk).
                Your tx will revert on-chain if you don&apos;t actually hold this PT.
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

        {writeError && (
          <div className="mt-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-error">
            {flowState.kind === "error" && (
              <div className="mb-1 font-semibold uppercase tracking-[1.5px]">
                {flowState.failedAt === "approve" ? "Approval failed" : "Swap failed"}
              </div>
            )}
            {writeError.slice(0, 240)}
          </div>
        )}

        {flowState.kind === "done" && lastTxHash && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-success">
            <div className="font-semibold uppercase tracking-[1px]">PT sold for SY.</div>
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
                  void ptRead.refetch();
                }}
                className="underline underline-offset-2 hover:text-text"
              >
                New trade
              </button>
            </div>
          </div>
        )}

        {!routerDeployed && (
          <p className="mt-2 font-mono text-[11px] text-error">Router not deployed yet.</p>
        )}
      </div>
    </div>
  );
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
