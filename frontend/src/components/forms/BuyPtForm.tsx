"use client";

/**
 * BuyPtForm — extracted from the previous TradeCard "pt" branch on the
 * market detail page. Single SY input → router.swapExactSyForPt → receive
 * PT to the connected account.
 *
 * Reuses:
 *   - useWalletAdapter for the unified EVM/Hedera signing path.
 *   - useWaitForTransactionReceipt (gated to EVM mode — Hedera adapter
 *     already awaits the receipt internally and returns a tx ID, which is
 *     not a 0x hash and would confuse Hashio polling).
 *   - AssociationGate is applied at the page level around this component.
 *
 * Redesigned UI (2026-05-14): USD-denominated input with a "≈ N SY"
 * equivalence line, slippage chip presets (no slider), and a FlowOfFunds
 * card above the form that visualizes where the money goes.
 */
import { useMemo, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate } from "@/components/MarketPositionCard";
import { useSyValueUsd } from "@/hooks/useSyValueUsd";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
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
  syBalance: bigint;
}

export function BuyPtForm({ market, detail, user, syBalance }: Props) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const { usdPerShare } = useSyValueUsd(detail.sy);
  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [rawStr, setRawStr] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const useWagmiReceipt = adapter.mode === "evm";
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: useWagmiReceipt ? txHash : undefined,
    query: { enabled: useWagmiReceipt },
  });
  const isConfirmedFinal = useWagmiReceipt ? isConfirmed : !!txHash;
  const isConfirmingFinal = useWagmiReceipt ? isConfirming : false;
  const routerDeployed = isDeployed(ADDRESSES.router);
  const isPending = isSubmitting || adapter.isWritePending;

  // Convert the user's input (USD or raw) to a raw SY-bigint. usdToRawBigInt
  // does a ceiled float divide — we'd rather overshoot by a unit than under-
  // pay vs the user's intended dollar number.
  const parsedAmt = useMemo<bigint>(() => {
    if (inputMode === "usd" && usdPerShare !== undefined) {
      return usdToRawBigInt(usdStr, usdPerShare);
    }
    return parseRawBigInt(rawStr);
  }, [inputMode, usdStr, rawStr, usdPerShare]);

  const insufficient = parsedAmt > syBalance;
  const needsSy = syBalance === 0n;
  // Pool-depth size cap. At small TVL a meaningful trade moves the implied
  // yield past the user's slippage tolerance and the tx would revert; we
  // gate at the UI layer instead.
  const sizeLimit = computeSizeLimit(parsedAmt, detail.totalSy, detail.totalPt);

  // Output preview — PT ≈ SY-in / ptRate, before slippage. We surface this
  // both in the input ("Buying ~16.3M PT") and on the FlowOfFunds last row.
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ptRate = ptToSyRate(apy, days); // 1 PT costs `ptRate` SY
  const ptEstimateNum =
    parsedAmt > 0n && ptRate > 0
      ? Number(parsedAmt) / Math.max(1e-9, ptRate)
      : 0;
  const ptEstimate = ptEstimateNum > 0 ? BigInt(Math.floor(ptEstimateNum)) : 0n;
  const minPtOut = (ptEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

  const spender: `0x${string}` = ADDRESSES.router;
  const allowanceRead = useReadContracts({
    contracts:
      user && parsedAmt > 0n && detail.syShare
        ? [
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
              address: detail.syShare,
              functionName: "allowance",
              args: [user, spender],
            } as const,
          ]
        : [],
    query: { enabled: !!user && parsedAmt > 0n },
    allowFailure: true,
  });
  const allowance =
    allowanceRead.data?.[0]?.status === "success"
      ? (allowanceRead.data[0].result as bigint)
      : 0n;
  const needsApprove = parsedAmt > 0n && allowance < parsedAmt;

  const wrap = async <T,>(fn: () => Promise<T>) => {
    setWriteError(null);
    setIsSubmitting(true);
    try {
      return await fn();
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setIsSubmitting(false);
    }
  };

  const onApprove = async () => {
    try {
      const { txHash: hash } = await wrap(() =>
        adapter.write({
          kind: "approveErc20",
          token: detail.syShare,
          spender,
          amount: parsedAmt,
        }),
      );
      setTxHash(hash as `0x${string}`);
    } catch {
      /* error already captured */
    }
  };

  const onTrade = async () => {
    if (!user || parsedAmt === 0n || !routerDeployed) return;
    if (parsedAmt > syBalance) return;
    if (needsApprove) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    // SY-side min — matches the legacy behaviour: a haircut on input SY so the
    // router's internal swap check has headroom. We additionally express the
    // PT-out floor in the UI via `minPtOut` but the router contract uses the
    // SY-side guardrail.
    const minOut = (parsedAmt * BigInt(10_000 - slippageBps)) / 10_000n;

    // Pre-flight HTS association for PT (PT is delivered to the user).
    if (adapter.mode === "hedera" && adapter.accountId) {
      try {
        const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
          await import("@/lib/hedera-wallet/associations");
        const ids = [detail.pt].map(evmAddressToTokenId);
        const missing = await getMissingAssociations(adapter.accountId, ids);
        if (missing.length > 0) {
          await wrap(() => associateTokens(hedera.getConnector(), adapter.accountId!, missing));
        }
      } catch (e) {
        setWriteError(e instanceof Error ? e.message : String(e));
        return;
      }
    }

    try {
      const { txHash: hash } = await wrap(() =>
        adapter.write({
          kind: "swapExactSyForPt",
          router: ADDRESSES.router,
          market,
          syIn: parsedAmt,
          minPtOut: minOut,
          receiver: user,
          deadline,
        }),
      );
      setTxHash(hash as `0x${string}`);
    } catch {
      /* error already captured */
    }
  };

  const onPrimary = () => {
    if (needsApprove) onApprove();
    else onTrade();
  };

  const resetWrite = () => {
    setTxHash(undefined);
    setWriteError(null);
  };

  // Build the FlowOfFunds steps from current input state. Highlights:
  //   - "Router" pulls active during pending
  //   - All steps go "complete" on tx success
  const isActive = isPending || isConfirmingFinal;
  const isDone = isConfirmedFinal;
  const flowSteps: FlowStep[] = [
    {
      label: "You pay",
      detail: "Connected wallet → Router",
      inToken:
        parsedAmt > 0n
          ? {
              sym: "SY",
              amount: formatCompact(parsedAmt),
              usd:
                usdPerShare !== undefined
                  ? `≈ $${(Number(parsedAmt) * usdPerShare).toFixed(2)}`
                  : undefined,
            }
          : undefined,
      isComplete: isDone,
    },
    {
      label: "Router",
      detail: shortAddr(ADDRESSES.router),
      isActive: isActive && !isDone,
      isComplete: isDone,
    },
    {
      label: "Fission AMM",
      detail: `swapExactSyForPt · ${apy.toFixed(2)}% impl APY`,
      isActive: isActive && !isDone,
      isComplete: isDone,
    },
    {
      label: "PT delivered",
      detail: `≤ ${(slippageBps / 100).toFixed(2)}% slippage`,
      outToken:
        ptEstimate > 0n
          ? {
              sym: "PT",
              amount: `~${formatCompact(ptEstimate)}`,
              usd:
                usdPerShare !== undefined
                  ? `min ${formatCompact(minPtOut)} PT`
                  : undefined,
            }
          : undefined,
      isComplete: isDone,
    },
    {
      label: "Your wallet",
      detail: user ? shortAddr(user) : "—",
      isComplete: isDone,
    },
  ];

  const poolHealthy = !sizeLimit.exceeded && sizeLimit.poolDepth > 0n;

  return (
    <div className="flex flex-col gap-3">
      <FlowOfFunds title="Flow of funds · Buy PT" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Buy PT"
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

        <SectionDivider label="Input" />

        <MoneyInput
          mode={inputMode}
          setMode={setInputMode}
          usdStr={usdStr}
          setUsdStr={setUsdStr}
          rawStr={rawStr}
          setRawStr={setRawStr}
          parsedRaw={parsedAmt}
          balance={syBalance}
          tokenSym="SY"
          label="You pay"
          usdPerUnit={usdPerShare}
          formatRaw={formatCompact}
          insufficient={insufficient}
          outputHint={
            ptEstimate > 0n ? (
              <span>
                Buying <span className="text-text">~{formatCompact(ptEstimate)} PT</span>
              </span>
            ) : undefined
          }
          minOutHint={
            ptEstimate > 0n ? (
              <span>
                Min received <span className="text-text">{formatCompact(minPtOut)} PT</span>
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
                Insufficient SY — you have {formatCompact(syBalance)}.
              </span>
            ) : sizeLimit.message ? (
              <span className="block font-mono text-[10px] font-medium text-warning">
                {sizeLimit.message}
              </span>
            ) : null
          }
        />

        {user && needsSy && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-warning">
            <span className="font-semibold">You have 0 SY shares.</span> Use
            the &ldquo;Need SY first?&rdquo; mint flow on the market overview
            to deposit HBAR and mint SY before buying PT.
          </div>
        )}

        <SectionDivider label="Routing" />

        <SlippageChips
          slippageBps={slippageBps}
          setSlippageBps={setSlippageBps}
          maxBps={100}
        />

        <SectionDivider label="Settlement" />

        <button
          type="button"
          disabled={
            !user ||
            parsedAmt === 0n ||
            isPending ||
            isConfirmingFinal ||
            insufficient ||
            sizeLimit.exceeded ||
            !routerDeployed
          }
          onClick={onPrimary}
          className="w-full rounded-[10px] bg-white px-7 py-3.5 font-mono text-sm font-semibold uppercase tracking-[1px] text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!user
            ? "Connect wallet"
            : parsedAmt === 0n
              ? "Enter amount"
              : insufficient
                ? "Insufficient SY"
                : sizeLimit.exceeded
                  ? "Trade too large for pool"
                  : isPending
                    ? "Sign in HashPack…"
                    : isConfirmingFinal
                      ? "Waiting for confirmation…"
                      : needsApprove
                        ? "Approve SY for Router"
                        : "Buy PT"}
        </button>

        {needsApprove && (
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-textDim">
            One-time per allowance reset. After approval the button switches to the trade.
          </p>
        )}

        {writeError && (
          <div className="mt-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-error">
            {writeError.slice(0, 240)}
          </div>
        )}

        {isConfirmedFinal && txHash && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-success">
            <div className="font-semibold uppercase tracking-[1px]">Transaction confirmed.</div>
            <div className="mt-1 break-all text-[10px] text-success/80">
              tx: {txHash.slice(0, 18)}…{txHash.slice(-8)}
            </div>
            <div className="mt-1.5 flex gap-3">
              <a
                href={`https://hashscan.io/mainnet/transaction/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-text"
              >
                View on HashScan
              </a>
              <button
                type="button"
                onClick={() => {
                  resetWrite();
                  setUsdStr("");
                  setRawStr("");
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
