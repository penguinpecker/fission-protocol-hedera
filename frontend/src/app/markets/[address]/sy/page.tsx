"use client";

/**
 * SY sub-page — sell loose SY shares for native HBAR via FissionUnzap.
 *
 * Users accumulate SY when a chain like Buy YT zaps HBAR → SY but the
 * follow-on swapExactPtForSy fails (MAX_CHILD_RECORDS, slippage, etc.).
 * Without a way to exit those SY shares, the residual just sits dust in
 * the user's wallet. This page wraps `FissionUnzap.unzapSy`:
 *
 *   1. Approve SY-share for the unzap (one-time int64.max)
 *   2. unzap.unzapSy(sharesIn, minHbarOut, receiver) → user gets native HBAR
 *
 * Steady-state 1 popup, first-time 2.
 */

import { useCallback, useMemo, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { MarketSubPageShell } from "@/components/MarketSubPageShell";
import type { MarketDetail } from "@/hooks/useMarket";
import { formatCompact } from "@/hooks/useMarkets";
import { useSyValueUsd, useHbarUsd } from "@/hooks/useSyValueUsd";
import { ADDRESSES, isDeployed, MAX_HTS_APPROVE } from "@/lib/addresses";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import {
  FormHeaderStrip,
  MoneyInput,
  parseRawBigInt,
  SectionDivider,
  SlippageChips,
  StatusPill,
  usdToRawBigInt,
} from "@/components/forms/_primitives";

export default function SyPage({ params }: { params: Promise<{ address: string }> }) {
  return (
    <MarketSubPageShell
      params={params}
      crumb="SY"
      renderEconomics={() => <SyEconomics />}
      renderTradeForm={({ detail, user, market }) => (
        <SellSyForm market={market} detail={detail} user={user} />
      )}
    />
  );
}

function SyEconomics() {
  return (
    <div>
      <h2 className="text-[18px] font-semibold tracking-tight text-text">Sell SY for HBAR</h2>
      <p className="mt-3 text-[13px] leading-relaxed text-textSec">
        Recover loose SY shares as native HBAR. SY is the wrapped form of the
        underlying SaucerSwap V2 LP NFT — selling SY redeems your pro-rata
        slice of the NFT (USDC + WHBAR), then swaps the USDC to WHBAR and
        unwraps everything to native HBAR. One transaction, lands in your
        wallet.
      </p>

      <ol className="mt-5 space-y-3 text-[13px] leading-relaxed text-textSec">
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            1
          </span>
          <span>
            Approve SY-share for the FissionUnzap (one-time; subsequent sells
            skip this step).
          </span>
        </li>
        <li className="flex gap-3">
          <span className="mt-[1px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-text">
            2
          </span>
          <span>
            FissionUnzap pulls your SY → calls{" "}
            <span className="font-mono text-text">sy.redeemLiquidity</span> →
            swaps USDC for WHBAR on SaucerSwap → unwraps WHBAR → sends HBAR
            to you. Atomic.
          </span>
        </li>
      </ol>

      <div className="mt-5 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-[12px] leading-relaxed text-textSec">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[1.5px] text-warning">
          Tradeoffs
        </div>
        Selling SY back to HBAR incurs the same SaucerSwap V2 swap fee + V3
        NFT redeem cost you paid on the way in. For sub-$1 amounts gas can
        be a larger fraction of value than the SY itself — consider whether
        spending the SY on Buy PT / Buy YT / Add LP (SY-mode) is a better use.
      </div>
    </div>
  );
}

interface FormProps {
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

function SellSyForm({ market, detail, user }: FormProps) {
  void market;
  const adapter = useWalletAdapter();
  const { usdPerShare } = useSyValueUsd(detail.sy);
  const hbarUsd = useHbarUsd();

  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [rawStr, setRawStr] = useState("");
  // Default 2% (200 bps) — the unzap pipeline has ~0.5-1% baked-in cost
  // from the V2 USDC→WHBAR swap fee + curve impact, so 0.5% defaults
  // reverted in live use (tx 0.0.10457309-1779736762-016232190). 2%
  // keeps small trades safe; user can tighten via the chips.
  const [slippageBps, setSlippageBps] = useState(200);

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

  const unzapDeployed = isDeployed(ADDRESSES.periphery);

  // SY balance + allowance to the unzap.
  const reads = useReadContracts({
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
            address: detail.syShare,
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
            address: detail.syShare,
            functionName: "allowance",
            args: [user, ADDRESSES.periphery],
          } as const,
        ]
      : [],
  });

  const syBalance: bigint = useMemo(() => {
    const r = reads.data?.[0];
    return r?.status === "success" ? (r.result as bigint) : 0n;
  }, [reads.data]);

  const syAllowance: bigint = useMemo(() => {
    const r = reads.data?.[1];
    return r?.status === "success" ? (r.result as bigint) : 0n;
  }, [reads.data]);

  /* ─────────────────────────── parsed amounts */

  const parsedSy = useMemo<bigint>(() => {
    if (inputMode === "usd" && usdPerShare !== undefined) {
      return usdToRawBigInt(usdStr, usdPerShare);
    }
    return parseRawBigInt(rawStr);
  }, [inputMode, usdStr, rawStr, usdPerShare]);

  const insufficient = parsedSy > syBalance;
  const needsApprove = syAllowance < parsedSy;

  // Expected HBAR output ≈ SY-in × $/share × 1/hbarUsd. The unzap returns
  // marginally less because of the SaucerSwap V2 swap fee on the USDC half.
  const expectedHbarOut: number = useMemo(() => {
    if (parsedSy === 0n || usdPerShare === undefined || hbarUsd === undefined) return 0;
    const usdValue = Number(parsedSy) * usdPerShare;
    return usdValue / Math.max(1e-9, hbarUsd);
  }, [parsedSy, usdPerShare, hbarUsd]);

  const minHbarOutTinybar: bigint = useMemo(() => {
    if (expectedHbarOut <= 0) return 1n;
    const tinybars = BigInt(Math.floor(expectedHbarOut * 1e8));
    return (tinybars * BigInt(10_000 - slippageBps)) / 10_000n;
  }, [expectedHbarOut, slippageBps]);

  /* ─────────────────────────── primary handler */

  const run = useCallback(async () => {
    if (!user || parsedSy === 0n || insufficient || !unzapDeployed) return;
    setWriteError(null);
    try {
      if (needsApprove) {
        setFlowState({ kind: "approving" });
        const aResp = await adapter.write({
          kind: "approveErc20",
          token: detail.syShare,
          spender: ADDRESSES.periphery,
          amount: MAX_HTS_APPROVE,
        });
        setLastTxHash(aResp.txHash);
        await new Promise((r) => setTimeout(r, adapter.mode === "evm" ? 3500 : 1500));
        await reads.refetch();
      }

      setFlowState({ kind: "selling" });
      // Post-rebuild: Periphery.unzapSyToHbar(syAdapter, sharesIn, minHbarOut, deadline).
      const uResp = await adapter.write({
        kind: "writePeriphery",
        functionName: "unzapSyToHbar",
        args: [detail.sy, parsedSy, minHbarOutTinybar, 0n],
      });
      setLastTxHash(uResp.txHash);
      setFlowState({ kind: "done", finalTxHash: uResp.txHash });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg, failedAt: needsApprove ? "approve" : "sell" });
    }
  }, [adapter, detail.sy, detail.syShare, insufficient, minHbarOutTinybar, needsApprove, parsedSy, reads, unzapDeployed, user]);

  /* ─────────────────────────── UI */

  const isPending =
    adapter.isWritePending ||
    flowState.kind === "approving" ||
    flowState.kind === "selling";

  const buttonLabel = (): string => {
    if (!user) return "Connect wallet";
    if (!unzapDeployed) return "Unzap not deployed";
    if (syBalance === 0n) return "No SY to sell";
    if (parsedSy === 0n) return "Enter amount";
    if (insufficient) return "Insufficient SY";
    if (flowState.kind === "approving") return "Approving SY for Unzap…";
    if (flowState.kind === "selling") return "Selling SY → HBAR…";
    if (flowState.kind === "done") return "✓ Done";
    if (flowState.kind === "error") return "Retry";
    if (isConfirmingFinal) return "Waiting for confirmation…";
    return needsApprove ? "Approve + Sell SY → HBAR" : "Sell SY → HBAR";
  };

  const buttonDisabled =
    !user ||
    !unzapDeployed ||
    isPending ||
    isConfirmingFinal ||
    parsedSy === 0n ||
    insufficient;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Sell SY → HBAR"
          right={<StatusPill tone="info">Unzap</StatusPill>}
        />

        <SectionDivider label="INPUT" />

        <MoneyInput
          mode={inputMode}
          setMode={setInputMode}
          usdStr={usdStr}
          setUsdStr={setUsdStr}
          rawStr={rawStr}
          setRawStr={setRawStr}
          parsedRaw={parsedSy}
          balance={syBalance}
          tokenSym="SY"
          label="You sell"
          usdPerUnit={usdPerShare}
          formatRaw={formatCompact}
          insufficient={insufficient}
          outputHint={
            expectedHbarOut > 0 ? (
              <span>
                Receiving <span className="text-text">~{expectedHbarOut.toFixed(4)} HBAR</span>
              </span>
            ) : undefined
          }
          minOutHint={
            expectedHbarOut > 0 ? (
              <span>
                Min received <span className="text-text">{(Number(minHbarOutTinybar) / 1e8).toFixed(4)} HBAR</span>
              </span>
            ) : undefined
          }
        />

        <SectionDivider label="SLIPPAGE" />
        <SlippageChips slippageBps={slippageBps} setSlippageBps={setSlippageBps} />

        <SectionDivider label="SETTLEMENT" />

        <button
          type="button"
          onClick={run}
          disabled={buttonDisabled}
          className="w-full rounded-[10px] bg-white px-7 py-3.5 font-mono text-sm font-semibold uppercase tracking-[1px] text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {buttonLabel()}
        </button>

        {writeError && (
          <div className="mt-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-error">
            {writeError.slice(0, 240)}
          </div>
        )}

        {isConfirmedFinal && lastTxHash && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-success">
            <div className="font-semibold uppercase tracking-[1px]">SY sold for HBAR.</div>
            <div className="mt-1 text-success/70">tx: {lastTxHash.slice(0, 14)}…</div>
          </div>
        )}
      </div>
    </div>
  );
}
