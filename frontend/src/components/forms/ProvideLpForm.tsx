"use client";

/**
 * ProvideLpForm — new LP-flow UI. Two tabs:
 *
 *   Add → SY + PT input (auto-balanced to current pool ratio), three
 *         on-chain steps:
 *           1. approveErc20(SY → Router)  (if allowance < syIn)
 *           2. approveErc20(PT → Router)  (if allowance < ptIn)
 *           3. addLiquidity(market, syIn, ptIn, minLpOut, receiver, deadline)
 *
 *   Remove → LP input, single step:
 *           1. removeLiquidity(market, lpIn, minSyOut, minPtOut, receiver, deadline)
 *
 * The user receives LP HTS shares on Add (or SY + PT on Remove), so the
 * AssociationGate must wrap this component upstream with the appropriate
 * token list per tab. The page-level component picks the right list.
 */
import { useMemo, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { formatCompact } from "@/hooks/useMarkets";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { erc20Abi } from "@/lib/abis";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";

interface Props {
  market: `0x${string}`;
  detail: MarketDetail;
  user: `0x${string}` | undefined;
  syBalance: bigint;
}

type Tab = "add" | "remove";

export function ProvideLpForm({ market, detail, user, syBalance }: Props) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const [tab, setTab] = useState<Tab>("add");

  // Balances we need that aren't already in `syBalance`: the user's PT and
  // LP balances. Read them directly here rather than threading useUserPosition
  // down — this component is self-contained.
  const balRead = useReadContracts({
    contracts: user
      ? [
          { abi: erc20Abi, address: detail.pt, functionName: "balanceOf", args: [user] } as const,
          { abi: erc20Abi, address: detail.lp, functionName: "balanceOf", args: [user] } as const,
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
            args: [user, ADDRESSES.router],
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
            args: [user, ADDRESSES.router],
          } as const,
        ]
      : [],
    query: { enabled: !!user },
    allowFailure: true,
  });
  const pluck = <T,>(
    e: { status: "success"; result: T } | { status: "failure"; error: Error } | undefined,
  ): T | undefined => (e?.status === "success" ? e.result : undefined);
  const ptBalance = pluck<bigint>(balRead.data?.[0] as never) ?? 0n;
  const lpBalance = pluck<bigint>(balRead.data?.[1] as never) ?? 0n;
  const syAllowance = pluck<bigint>(balRead.data?.[2] as never) ?? 0n;
  const ptAllowance = pluck<bigint>(balRead.data?.[3] as never) ?? 0n;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl border border-border bg-bgCard p-3">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setTab("add")}
            className={`flex-1 rounded-lg border px-2 py-2 text-[13px] font-medium transition ${
              tab === "add"
                ? "border-borderHover bg-white/[0.06] text-text"
                : "border-border text-textDim hover:bg-white/[0.04]"
            }`}
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setTab("remove")}
            disabled={lpBalance === 0n}
            className={`flex-1 rounded-lg border px-2 py-2 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
              tab === "remove"
                ? "border-borderHover bg-white/[0.06] text-text"
                : "border-border text-textDim hover:bg-white/[0.04]"
            }`}
          >
            Remove
          </button>
        </div>
        {lpBalance === 0n && tab === "remove" && (
          <p className="mt-2 text-[11px] text-textDim">You have 0 LP — nothing to remove yet.</p>
        )}
      </div>

      {tab === "add" ? (
        <AddLp
          market={market}
          detail={detail}
          user={user}
          syBalance={syBalance}
          ptBalance={ptBalance}
          syAllowance={syAllowance}
          ptAllowance={ptAllowance}
          adapter={adapter}
          hedera={hedera}
        />
      ) : (
        <RemoveLp
          market={market}
          detail={detail}
          user={user}
          lpBalance={lpBalance}
          adapter={adapter}
        />
      )}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────── Add */

interface AddProps {
  market: `0x${string}`;
  detail: MarketDetail;
  user: `0x${string}` | undefined;
  syBalance: bigint;
  ptBalance: bigint;
  syAllowance: bigint;
  ptAllowance: bigint;
  adapter: ReturnType<typeof useWalletAdapter>;
  hedera: ReturnType<typeof useHederaWallet>;
}

function AddLp({
  market,
  detail,
  user,
  syBalance,
  ptBalance,
  syAllowance,
  ptAllowance,
  adapter,
  hedera,
}: AddProps) {
  const [syIn, setSyIn] = useState("");
  const [ptIn, setPtIn] = useState("");
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
  const isPending = isSubmitting || adapter.isWritePending;
  const routerDeployed = isDeployed(ADDRESSES.router);

  // Pool composition. addLiquidityProportional needs (syIn, ptIn) at the
  // current AMM ratio — if they don't match the router reverts. We auto-fill
  // the PT input from SY input (one-way binding, user can override after).
  const totalSy = detail.totalSy;
  const totalPt = detail.totalPt;
  const hasPool = totalSy > 0n && totalPt > 0n;

  const parsedSy = parseRawBigInt(syIn);
  const parsedPt = parseRawBigInt(ptIn);

  // Suggested PT for a given SY input. Avoids per-keystroke reflow by using
  // useMemo on the current pool ratio. If pool isn't seeded we can't suggest.
  const suggestedPt = useMemo(() => {
    if (!hasPool || parsedSy === 0n) return 0n;
    return (parsedSy * totalPt) / totalSy;
  }, [hasPool, parsedSy, totalSy, totalPt]);

  const onSyChange = (v: string) => {
    setSyIn(v);
    // Auto-fill PT on SY change. The user can still type a different value
    // in the PT field; we only push when the user types in the SY field.
    if (hasPool) {
      const next = parseRawBigInt(v);
      if (next > 0n) {
        const suggest = (next * totalPt) / totalSy;
        setPtIn(suggest.toString());
      } else {
        setPtIn("");
      }
    }
  };

  const insufficientSy = parsedSy > syBalance;
  const insufficientPt = parsedPt > ptBalance;
  const needsSyApprove = parsedSy > 0n && syAllowance < parsedSy;
  const needsPtApprove = parsedPt > 0n && ptAllowance < parsedPt;
  const noInput = parsedSy === 0n || parsedPt === 0n;

  // Need PT to add proportional liquidity. The user must already hold PT
  // (from a prior Buy PT / Split). We make the UI explicit about this.
  const noPt = ptBalance === 0n;

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

  const onApproveSy = async () => {
    try {
      const { txHash: hash } = await wrap(() =>
        adapter.write({
          kind: "approveErc20",
          token: detail.syShare,
          spender: ADDRESSES.router,
          amount: parsedSy,
        }),
      );
      setTxHash(hash as `0x${string}`);
    } catch {
      /* error captured */
    }
  };

  const onApprovePt = async () => {
    try {
      const { txHash: hash } = await wrap(() =>
        adapter.write({
          kind: "approveErc20",
          token: detail.pt,
          spender: ADDRESSES.router,
          amount: parsedPt,
        }),
      );
      setTxHash(hash as `0x${string}`);
    } catch {
      /* error captured */
    }
  };

  const onAdd = async () => {
    if (!user || noInput || !routerDeployed) return;
    if (insufficientSy || insufficientPt) return;

    // Pre-flight HTS association for LP token (the user receives LP shares).
    if (adapter.mode === "hedera" && adapter.accountId) {
      try {
        const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
          await import("@/lib/hedera-wallet/associations");
        const ids = [detail.lp].map(evmAddressToTokenId);
        const missing = await getMissingAssociations(adapter.accountId, ids);
        if (missing.length > 0) {
          await wrap(() => associateTokens(hedera.getConnector(), adapter.accountId!, missing));
        }
      } catch (e) {
        setWriteError(e instanceof Error ? e.message : String(e));
        return;
      }
    }

    // Rough LP-out estimate: pro-rata against existing lpSupply / totalSy.
    // We minOut down by slippage; the router enforces a more precise check
    // internally using its own math.
    const lpEstimate =
      detail.lpSupply > 0n && totalSy > 0n
        ? (parsedSy * detail.lpSupply) / totalSy
        : parsedSy; // fresh pool — placeholder estimate
    const minLpOut = (lpEstimate * BigInt(10_000 - slippageBps)) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    try {
      const { txHash: hash } = await wrap(() =>
        adapter.write({
          kind: "addLiquidity",
          router: ADDRESSES.router,
          market,
          syIn: parsedSy,
          ptIn: parsedPt,
          minLpOut,
          receiver: user,
          deadline,
        }),
      );
      setTxHash(hash as `0x${string}`);
    } catch {
      /* error captured */
    }
  };

  const onPrimary = () => {
    if (needsSyApprove) onApproveSy();
    else if (needsPtApprove) onApprovePt();
    else onAdd();
  };

  const ratioLabel =
    hasPool && totalSy > 0n
      ? `1 SY : ${(Number(totalPt) / Number(totalSy)).toFixed(4)} PT`
      : "—";

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
          Add liquidity
        </div>
        <span className="font-mono text-[10px] text-textDim">Ratio: {ratioLabel}</span>
      </div>

      {noPt ? (
        <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12px] leading-relaxed text-warning">
          <span className="font-semibold">You need PT to add proportional liquidity.</span>{" "}
          Buy PT first (or split SY → PT + YT and keep the PT side), then return here.
        </div>
      ) : null}

      <label className="mb-3 block">
        <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
          <span>SY amount</span>
          <span className="font-mono text-[11px] text-textDim">
            Balance: {formatCompact(syBalance)}
            {syBalance > 0n && (
              <button
                type="button"
                onClick={() => onSyChange(syBalance.toString())}
                className="ml-2 rounded border border-borderHover bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08]"
              >
                Max
              </button>
            )}
          </span>
        </span>
        <input
          type="number"
          value={syIn}
          onChange={(e) => onSyChange(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          className={`w-full rounded-[10px] border bg-bgInput px-4 py-3 font-mono text-sm text-text outline-none transition ${
            insufficientSy ? "border-error/60 focus:border-error" : "border-border focus:border-borderHover"
          }`}
        />
        {insufficientSy && (
          <span className="mt-1 block text-[11px] font-medium text-error">
            Insufficient SY.
          </span>
        )}
      </label>

      <label className="mb-3 block">
        <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
          <span>PT amount</span>
          <span className="font-mono text-[11px] text-textDim">
            Balance: {formatCompact(ptBalance)}
            {ptBalance > 0n && (
              <button
                type="button"
                onClick={() => setPtIn(ptBalance.toString())}
                className="ml-2 rounded border border-borderHover bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08]"
              >
                Max
              </button>
            )}
          </span>
        </span>
        <input
          type="number"
          value={ptIn}
          onChange={(e) => setPtIn(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          className={`w-full rounded-[10px] border bg-bgInput px-4 py-3 font-mono text-sm text-text outline-none transition ${
            insufficientPt ? "border-error/60 focus:border-error" : "border-border focus:border-borderHover"
          }`}
        />
        {suggestedPt > 0n && parsedPt !== suggestedPt && (
          <span className="mt-1 block text-[10px] text-textDim">
            Suggested at current ratio: {formatCompact(suggestedPt)} PT
          </span>
        )}
        {insufficientPt && (
          <span className="mt-1 block text-[11px] font-medium text-error">
            Insufficient PT.
          </span>
        )}
      </label>

      <label className="mb-3 block">
        <span className="mb-1.5 block text-xs text-textSec">
          Slippage tolerance: {(slippageBps / 100).toFixed(2)}%
        </span>
        <input
          type="range"
          min={5}
          max={500}
          value={slippageBps}
          onChange={(e) => setSlippageBps(Number(e.target.value))}
          className="w-full"
        />
      </label>

      <button
        type="button"
        disabled={
          !user ||
          noInput ||
          isPending ||
          isConfirmingFinal ||
          insufficientSy ||
          insufficientPt ||
          !routerDeployed ||
          noPt
        }
        onClick={onPrimary}
        className="w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!user
          ? "Connect wallet"
          : noPt
            ? "You need PT — buy PT first"
            : noInput
              ? "Enter amounts"
              : insufficientSy || insufficientPt
                ? "Insufficient balance"
                : isPending
                  ? "Sign in HashPack…"
                  : isConfirmingFinal
                    ? "Waiting for confirmation…"
                    : needsSyApprove
                      ? "Approve SY for Router"
                      : needsPtApprove
                        ? "Approve PT for Router"
                        : "Add liquidity"}
      </button>

      {(needsSyApprove || needsPtApprove) && !noInput && (
        <p className="mt-2 text-[10px] leading-relaxed text-textDim">
          Two approvals (SY + PT), then the add-liquidity tx. One HashPack popup each.
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
                setTxHash(undefined);
                setWriteError(null);
                setSyIn("");
                setPtIn("");
              }}
              className="underline underline-offset-2 hover:text-text"
            >
              New deposit
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

/* ─────────────────────────────────────────────────────────── Remove */

interface RemoveProps {
  market: `0x${string}`;
  detail: MarketDetail;
  user: `0x${string}` | undefined;
  lpBalance: bigint;
  adapter: ReturnType<typeof useWalletAdapter>;
}

function RemoveLp({ market, detail, user, lpBalance, adapter }: RemoveProps) {
  const [lpIn, setLpIn] = useState("");
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
  const isPending = isSubmitting || adapter.isWritePending;
  const routerDeployed = isDeployed(ADDRESSES.router);

  // LP-Router allowance: the router pulls the user's LP via transferFrom.
  const allowanceRead = useReadContracts({
    contracts: user
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
            address: detail.lp,
            functionName: "allowance",
            args: [user, ADDRESSES.router],
          } as const,
        ]
      : [],
    query: { enabled: !!user },
    allowFailure: true,
  });
  const lpAllowance =
    allowanceRead.data?.[0]?.status === "success"
      ? (allowanceRead.data[0].result as bigint)
      : 0n;

  const parsedLp = parseRawBigInt(lpIn);
  const insufficientLp = parsedLp > lpBalance;
  const needsLpApprove = parsedLp > 0n && lpAllowance < parsedLp;

  // Expected SY + PT out at current pool composition (informational only).
  const expectedSy =
    detail.lpSupply > 0n
      ? (parsedLp * detail.totalSy) / detail.lpSupply
      : 0n;
  const expectedPt =
    detail.lpSupply > 0n
      ? (parsedLp * detail.totalPt) / detail.lpSupply
      : 0n;

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
          token: detail.lp,
          spender: ADDRESSES.router,
          amount: parsedLp,
        }),
      );
      setTxHash(hash as `0x${string}`);
    } catch {
      /* error captured */
    }
  };

  const onRemove = async () => {
    if (!user || parsedLp === 0n || !routerDeployed || insufficientLp) return;
    const minSyOut = (expectedSy * BigInt(10_000 - slippageBps)) / 10_000n;
    const minPtOut = (expectedPt * BigInt(10_000 - slippageBps)) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    try {
      const { txHash: hash } = await wrap(() =>
        adapter.write({
          kind: "removeLiquidity",
          router: ADDRESSES.router,
          market,
          lpIn: parsedLp,
          minSyOut,
          minPtOut,
          receiver: user,
          deadline,
        }),
      );
      setTxHash(hash as `0x${string}`);
    } catch {
      /* error captured */
    }
  };

  const onPrimary = () => {
    if (needsLpApprove) onApprove();
    else onRemove();
  };

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
        Remove liquidity
      </div>

      <label className="mb-3 block">
        <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
          <span>LP to withdraw</span>
          <span className="font-mono text-[11px] text-textDim">
            Balance: {formatCompact(lpBalance)}
            {lpBalance > 0n && (
              <button
                type="button"
                onClick={() => setLpIn(lpBalance.toString())}
                className="ml-2 rounded border border-borderHover bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08]"
              >
                Max
              </button>
            )}
          </span>
        </span>
        <input
          type="number"
          value={lpIn}
          onChange={(e) => setLpIn(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          className={`w-full rounded-[10px] border bg-bgInput px-4 py-3 font-mono text-sm text-text outline-none transition ${
            insufficientLp ? "border-error/60 focus:border-error" : "border-border focus:border-borderHover"
          }`}
        />
      </label>

      {parsedLp > 0n && (
        <div className="mb-3 rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-textSec">
          You will receive approximately{" "}
          <span className="font-mono text-text">{formatCompact(expectedSy)} SY</span>{" "}
          and{" "}
          <span className="font-mono text-text">{formatCompact(expectedPt)} PT</span>.
        </div>
      )}

      <label className="mb-3 block">
        <span className="mb-1.5 block text-xs text-textSec">
          Slippage tolerance: {(slippageBps / 100).toFixed(2)}%
        </span>
        <input
          type="range"
          min={5}
          max={500}
          value={slippageBps}
          onChange={(e) => setSlippageBps(Number(e.target.value))}
          className="w-full"
        />
      </label>

      <button
        type="button"
        disabled={!user || parsedLp === 0n || isPending || isConfirmingFinal || insufficientLp || !routerDeployed}
        onClick={onPrimary}
        className="w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!user
          ? "Connect wallet"
          : parsedLp === 0n
            ? "Enter LP amount"
            : insufficientLp
              ? "Insufficient LP"
              : isPending
                ? "Sign in HashPack…"
                : isConfirmingFinal
                  ? "Waiting for confirmation…"
                  : needsLpApprove
                    ? "Approve LP for Router"
                    : "Remove liquidity"}
      </button>

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
                setTxHash(undefined);
                setWriteError(null);
                setLpIn("");
              }}
              className="underline underline-offset-2 hover:text-text"
            >
              New withdrawal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────── helpers */

function parseRawBigInt(s: string): bigint {
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
