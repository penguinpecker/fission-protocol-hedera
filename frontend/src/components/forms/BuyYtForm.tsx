"use client";

/**
 * BuyYtForm — extracted from the previous TradeCard "yt" branch on the
 * market detail page. Single SY input → router.buyYT → receive YT to the
 * connected account (any unused SY budget is refunded).
 *
 * Redesigned UI (2026-05-14): same techy treatment as BuyPtForm — USD input,
 * slippage chips, FlowOfFunds visualization. YT is the inverse swap: 1 YT
 * costs `1 - ptRate` SY today, accrues underlying yield until maturity.
 */
import { useMemo, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ytToSyRate } from "@/components/MarketPositionCard";
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

export function BuyYtForm({ market, detail, user, syBalance }: Props) {
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

  const parsedAmt = useMemo<bigint>(() => {
    if (inputMode === "usd" && usdPerShare !== undefined) {
      return usdToRawBigInt(usdStr, usdPerShare);
    }
    return parseRawBigInt(rawStr);
  }, [inputMode, usdStr, rawStr, usdPerShare]);

  const insufficient = parsedAmt > syBalance;
  const needsSy = syBalance === 0n;
  const sizeLimit = computeSizeLimit(parsedAmt, detail.totalSy, detail.totalPt);

  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ytRate = ytToSyRate(apy, days); // SY per YT (small number)
  const ytEstimateNum =
    parsedAmt > 0n && ytRate > 0
      ? Number(parsedAmt) / Math.max(1e-9, ytRate)
      : 0;
  const ytEstimate = ytEstimateNum > 0 ? BigInt(Math.floor(ytEstimateNum)) : 0n;
  const minYtOut = (ytEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

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
    const minOut = (parsedAmt * BigInt(10_000 - slippageBps)) / 10_000n;

    // Pre-flight HTS association for YT.
    if (adapter.mode === "hedera" && adapter.accountId) {
      try {
        const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
          await import("@/lib/hedera-wallet/associations");
        const ids = [detail.yt].map(evmAddressToTokenId);
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
          kind: "buyYT",
          router: ADDRESSES.router,
          market,
          syBudget: parsedAmt,
          minSyOut: minOut,
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
      detail: "Pendle inverse swap (YT leverage)",
      isActive: isActive && !isDone,
      isComplete: isDone,
    },
    {
      label: "YT delivered",
      detail: `≤ ${(slippageBps / 100).toFixed(2)}% slippage · yield accrues now`,
      outToken:
        ytEstimate > 0n
          ? {
              sym: "YT",
              amount: `~${formatCompact(ytEstimate)}`,
              usd: `min ${formatCompact(minYtOut)} YT`,
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
      <FlowOfFunds title="Flow of funds · Buy YT" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Buy YT"
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
          label="SY budget"
          usdPerUnit={usdPerShare}
          formatRaw={formatCompact}
          insufficient={insufficient}
          outputHint={
            ytEstimate > 0n ? (
              <span>
                Buying <span className="text-text">~{formatCompact(ytEstimate)} YT</span>
              </span>
            ) : undefined
          }
          minOutHint={
            ytEstimate > 0n ? (
              <span>
                Min received <span className="text-text">{formatCompact(minYtOut)} YT</span>
              </span>
            ) : undefined
          }
          caption={
            <>
              Pool depth: {formatCompact(sizeLimit.poolDepth)} · max trade{" "}
              {MAX_TRADE_PCT_OF_POOL}% = {formatCompact(sizeLimit.maxAllowed)}
              {" · "}gas ~0.10 HBAR
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
            <span className="font-semibold">You have 0 SY shares.</span> Mint
            SY from the market overview before buying YT.
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
                        : "Buy YT"}
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
