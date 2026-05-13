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
 */
import { useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { formatCompact } from "@/hooks/useMarkets";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { computeSizeLimit, MAX_TRADE_PCT_OF_POOL } from "@/lib/trade-limits";

interface Props {
  market: `0x${string}`;
  detail: MarketDetail;
  user: `0x${string}` | undefined;
  syBalance: bigint;
}

export function BuyPtForm({ market, detail, user, syBalance }: Props) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const [amount, setAmount] = useState("");
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

  let parsedAmt = 0n;
  try {
    if (amount) {
      const cleaned = amount.trim().replace(/,/g, "");
      if (/^[0-9]+(\.0+)?$/.test(cleaned)) {
        parsedAmt = BigInt(cleaned.split(".")[0] ?? "0");
      }
    }
  } catch {
    parsedAmt = 0n;
  }
  const insufficient = parsedAmt > syBalance;
  const needsSy = syBalance === 0n;
  // Pool-depth size cap. At small TVL a meaningful trade moves the implied
  // yield past the user's slippage tolerance and the tx would revert; we
  // gate at the UI layer instead.
  const sizeLimit = computeSizeLimit(parsedAmt, detail.totalSy, detail.totalPt);

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
    if (!user || !amount || !routerDeployed) return;
    if (parsedAmt > syBalance) return;
    if (needsApprove) return;
    const amt = parsedAmt;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const minOut = (amt * BigInt(10_000 - slippageBps)) / 10_000n;

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
          syIn: amt,
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

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
        Buy PT
      </div>

      <label className="mb-3 block">
        <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
          <span>You pay (SY)</span>
          <span className="font-mono text-[11px] text-textDim">
            Balance: {formatCompact(syBalance)}
            {syBalance > 0n && (
              <button
                type="button"
                onClick={() => setAmount(syBalance.toString())}
                className="ml-2 rounded border border-borderHover bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08]"
              >
                Max
              </button>
            )}
          </span>
        </span>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          className={`w-full rounded-[10px] border bg-bgInput px-4 py-3.5 font-mono text-base text-text outline-none transition ${
            insufficient ? "border-error/60 focus:border-error" : "border-border focus:border-borderHover"
          }`}
        />
        {insufficient && (
          <span className="mt-1.5 block text-[11px] font-medium text-error">
            Insufficient SY — you have {formatCompact(syBalance)}.
          </span>
        )}
        {!insufficient && sizeLimit.message && (
          <span className="mt-1.5 block text-[11px] font-medium text-warning">
            {sizeLimit.message}
          </span>
        )}
        <span className="mt-1.5 block text-[10px] text-textDim">
          Pool depth: {formatCompact(sizeLimit.poolDepth)} · max trade {MAX_TRADE_PCT_OF_POOL}% = {formatCompact(sizeLimit.maxAllowed)}
        </span>
      </label>

      {user && needsSy && (
        <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12px] leading-relaxed text-warning">
          <span className="font-semibold">You have 0 SY shares.</span> Use the
          &ldquo;Need SY first?&rdquo; mint flow on the market overview to deposit
          HBAR and mint SY before buying PT.
        </div>
      )}

      <label className="mb-3 block">
        <span className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-textSec">Slippage tolerance: {(slippageBps / 100).toFixed(2)}%</span>
          {slippageBps > 50 && (
            <span className="font-mono text-[10px] uppercase tracking-[1px] text-warning">⚠ above safe</span>
          )}
        </span>
        <input
          type="range"
          min={5}
          max={100}
          value={slippageBps}
          onChange={(e) => setSlippageBps(Number(e.target.value))}
          className="w-full"
        />
        <span className="mt-1 block text-[10px] text-textDim">
          Capped at 1.00%. Combined with the 1%-of-pool trade-size limit, actual slippage stays well under your tolerance.
        </span>
      </label>

      <button
        type="button"
        disabled={!user || !amount || isPending || isConfirmingFinal || insufficient || sizeLimit.exceeded || !routerDeployed}
        onClick={onPrimary}
        className="w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!user
          ? "Connect wallet"
          : !amount
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
        <p className="mt-2 text-[10px] leading-relaxed text-textDim">
          One-time per allowance reset. After approval the button switches to the trade.
        </p>
      )}

      {writeError && (
        <div className="mt-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[11px] leading-relaxed text-error">
          <span className="font-mono">{writeError.slice(0, 240)}</span>
        </div>
      )}

      {isConfirmedFinal && txHash && (
        <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-[12px] leading-relaxed text-success">
          <div className="font-semibold">Transaction confirmed.</div>
          <div className="mt-1 break-all font-mono text-[10px] text-success/80">
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
                setAmount("");
              }}
              className="underline underline-offset-2 hover:text-text"
            >
              New trade
            </button>
          </div>
        </div>
      )}

      {!routerDeployed && (
        <p className="mt-2 text-[11px] text-error">Router not deployed yet.</p>
      )}
    </div>
  );
}
