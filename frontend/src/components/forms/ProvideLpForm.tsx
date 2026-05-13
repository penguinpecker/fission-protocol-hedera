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
 * Redesigned UI (2026-05-14): USD-denominated input on the Add side (split
 * into the SY-half and PT-half by current pool ratio), slippage chips
 * everywhere, FlowOfFunds visualization above each tab.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate } from "@/components/MarketPositionCard";
import { useSyValueUsd } from "@/hooks/useSyValueUsd";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { erc20Abi } from "@/lib/abis";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
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

type Tab = "add" | "remove";

export function ProvideLpForm({ market, detail, user, syBalance }: Props) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const [tab, setTab] = useState<Tab>("add");

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
            args: [user, market],
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
            args: [user, market],
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
      <div className="rounded-2xl border border-border bg-bgCard p-2.5">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setTab("add")}
            className={`flex-1 rounded-lg border px-2 py-2 font-mono text-[11px] uppercase tracking-[1.5px] transition ${
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
            className={`flex-1 rounded-lg border px-2 py-2 font-mono text-[11px] uppercase tracking-[1.5px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
              tab === "remove"
                ? "border-borderHover bg-white/[0.06] text-text"
                : "border-border text-textDim hover:bg-white/[0.04]"
            }`}
          >
            Remove
          </button>
        </div>
        {lpBalance === 0n && tab === "remove" && (
          <p className="mt-2 font-mono text-[10px] text-textDim">You have 0 LP — nothing to remove yet.</p>
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
  const { usdPerShare } = useSyValueUsd(detail.sy);
  // Single USD input represents the total deposit value. The split is driven
  // by the current pool ratio: pool-half goes to SY-half, the rest to PT.
  // PT's $-value uses ptToSyRate (PT trades at a discount).
  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [syRawStr, setSyRawStr] = useState("");
  const [ptOverrideStr, setPtOverrideStr] = useState("");
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
  // the PT input from the SY-half (one-way binding; user can still override
  // PT manually via the dedicated field).
  const totalSy = detail.totalSy;
  const totalPt = detail.totalPt;
  const hasPool = totalSy > 0n && totalPt > 0n;
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ptRate = ptToSyRate(apy, days); // PT trades at `ptRate` SY/PT

  // Derive raw SY-in from input. In USD mode we split the dollar amount into
  // an SY-half whose $-value equals (totalSy / poolValue) × usd. Pool value
  // is approximated using ptRate (1 PT ≈ ptRate SY worth).
  //
  // poolSy_$ = totalSy × usdPerShare
  // poolPt_$ = totalPt × ptRate × usdPerShare
  // syIn_$ = usd × poolSy_$ / (poolSy_$ + poolPt_$)
  //        = usd × totalSy / (totalSy + totalPt × ptRate)
  // Then syIn_raw = syIn_$ / usdPerShare = usd / usdPerShare × syRatio.
  const syRatio = useMemo<number>(() => {
    if (!hasPool) return 1;
    const denom = Number(totalSy) + Number(totalPt) * ptRate;
    if (denom <= 0) return 1;
    return Number(totalSy) / denom;
  }, [hasPool, totalSy, totalPt, ptRate]);

  const parsedSy = useMemo<bigint>(() => {
    if (inputMode === "usd" && usdPerShare !== undefined) {
      const usd = parseFloat(usdStr.replace(/,/g, ""));
      if (!Number.isFinite(usd) || usd <= 0) return 0n;
      const syUsd = usd * syRatio;
      return usdToRawBigInt(syUsd.toFixed(6), usdPerShare);
    }
    return parseRawBigInt(syRawStr);
  }, [inputMode, usdStr, syRawStr, usdPerShare, syRatio]);

  // PT side: derived from SY at pool ratio. User can override via the PT
  // override field (advanced — most users should leave it auto-balanced).
  const suggestedPt = useMemo<bigint>(() => {
    if (!hasPool || parsedSy === 0n) return 0n;
    return (parsedSy * totalPt) / totalSy;
  }, [hasPool, parsedSy, totalSy, totalPt]);
  const parsedPt = ptOverrideStr ? parseRawBigInt(ptOverrideStr) : suggestedPt;

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

  // Add Liquidity bypasses the router (router has a typing bug — it casts
  // the SY contract as IERC20 instead of using sy.shareToken(), so the
  // transferFrom reverts). We call market.addLiquidity directly, which
  // means both approvals are to the MARKET, not the Router.
  const onApproveSy = async () => {
    try {
      const { txHash: hash } = await wrap(() =>
        adapter.write({
          kind: "approveErc20",
          token: detail.syShare,
          spender: market,
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
          spender: market,
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

  const lpEstimate =
    detail.lpSupply > 0n && totalSy > 0n
      ? (parsedSy * detail.lpSupply) / totalSy
      : 0n;
  const minLpOut = (lpEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

  const isActive = isPending || isConfirmingFinal;
  const isDone = isConfirmedFinal;
  const flowSteps: FlowStep[] = [
    {
      label: "You deposit",
      detail: "SY + PT pair (proportional)",
      inToken:
        parsedSy > 0n
          ? {
              sym: "SY",
              amount: formatCompact(parsedSy),
              usd:
                usdPerShare !== undefined
                  ? `≈ $${(Number(parsedSy) * usdPerShare).toFixed(2)}`
                  : undefined,
            }
          : undefined,
      outToken:
        parsedPt > 0n
          ? {
              sym: "PT",
              amount: formatCompact(parsedPt),
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
      label: "addLiquidityProportional",
      detail: `current ratio ${ratioLabel}`,
      isActive: isActive && !isDone,
      isComplete: isDone,
    },
    {
      label: "Market LP mint",
      detail: `≤ ${(slippageBps / 100).toFixed(2)}% slippage`,
      outToken:
        lpEstimate > 0n
          ? {
              sym: "LP",
              amount: `~${formatCompact(lpEstimate)}`,
              usd: `min ${formatCompact(minLpOut)} LP`,
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

  // SOURCE toggle scaffold. HBAR-mode is disabled-with-explainer for now —
  // LP-from-HBAR needs a multi-hop zap (HBAR → SY → split SY budget → buy PT
  // → approve SY + PT → addLiquidityProportional) which is queued for
  // Phase 8 MegaZap. For now only SY-mode is wired up.
  const [source, setSource] = useState<"hbar" | "sy">("sy");

  return (
    <div className="flex flex-col gap-3">
      <FlowOfFunds title="Flow of funds · Add liquidity" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Add liquidity"
          right={
            <>
              {usdPerShare === undefined && (
                <StatusPill tone="info">Price loading</StatusPill>
              )}
              <StatusPill tone="neutral">{ratioLabel}</StatusPill>
              {(needsSyApprove || needsPtApprove) && (
                <StatusPill tone="warning">Needs approval</StatusPill>
              )}
            </>
          }
        />

        {/* SOURCE toggle — HBAR is queued for Phase 8 MegaZap, see explainer below. */}
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-textDim">
              Source
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[1.5px] text-textDim">
              HBAR mode soon
            </span>
          </div>
          <div className="flex items-stretch gap-1.5">
            <button
              type="button"
              onClick={() => setSource("hbar")}
              className={`flex-1 rounded-[6px] border px-2 py-1.5 font-mono text-[11px] uppercase tracking-[1.5px] transition ${
                source === "hbar"
                  ? "border-warning/60 bg-warning/10 text-warning"
                  : "border-border bg-bgInput text-textSec hover:border-borderHover hover:text-text"
              }`}
            >
              HBAR
            </button>
            <button
              type="button"
              onClick={() => setSource("sy")}
              className={`flex-1 rounded-[6px] border px-2 py-1.5 font-mono text-[11px] uppercase tracking-[1.5px] transition ${
                source === "sy"
                  ? "border-text/60 bg-white/[0.08] text-text"
                  : "border-border bg-bgInput text-textSec hover:border-borderHover hover:text-text"
              }`}
            >
              SY
            </button>
          </div>
        </div>

        {source === "hbar" && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-warning">
            <div className="mb-1 font-semibold uppercase tracking-[1px]">
              LP from HBAR — coming in Phase 8
            </div>
            <p className="mb-2">
              Adding LP from raw HBAR needs a multi-hop zap (HBAR → SY → split
              budget → buy PT → approve SY + PT → addLiquidity). That lands in a
              future MegaZap contract upgrade.
            </p>
            <p>
              For now, mint SY + buy PT first, then return here in SY mode.{" "}
              <Link
                href={`/markets/${market}/pt`}
                className="underline underline-offset-2 hover:text-text"
              >
                Buy PT (auto-mints SY from HBAR) →
              </Link>
            </p>
          </div>
        )}

        {source === "sy" && noPt ? (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-warning">
            <span className="font-semibold">You need PT to add proportional liquidity.</span>{" "}
            <Link href={`/markets/${market}/pt`} className="underline underline-offset-2 hover:text-text">
              Buy PT first
            </Link>{" "}
            (or split SY → PT + YT and keep the PT side), then return here.
          </div>
        ) : null}

        <SectionDivider label="Input" />

        <MoneyInput
          mode={inputMode}
          setMode={setInputMode}
          usdStr={usdStr}
          setUsdStr={setUsdStr}
          rawStr={syRawStr}
          setRawStr={setSyRawStr}
          parsedRaw={parsedSy}
          balance={syBalance}
          tokenSym="SY"
          label="Total deposit (SY side)"
          usdPerUnit={usdPerShare}
          formatRaw={formatCompact}
          insufficient={insufficientSy}
          outputHint={
            parsedPt > 0n ? (
              <span>
                Paired with <span className="text-text">{formatCompact(parsedPt)} PT</span>
                {" · "}LP est <span className="text-text">~{formatCompact(lpEstimate)}</span>
              </span>
            ) : undefined
          }
          minOutHint={
            lpEstimate > 0n ? (
              <span>
                Min received <span className="text-text">{formatCompact(minLpOut)} LP</span>
              </span>
            ) : undefined
          }
          caption={
            <>
              Pool ratio {ratioLabel} · gas ~0.12 HBAR
            </>
          }
          feedback={
            // Distinguish SY-side vs PT-side vs both shortfalls so the user
            // knows exactly which token they're missing (previous build
            // surfaced a generic "INSUFFICIENT BALANCE" with no hint at all).
            insufficientSy && insufficientPt ? (
              <span className="block font-mono text-[10px] font-medium text-error">
                Insufficient balances — need {formatCompact(parsedSy)} SY +{" "}
                {formatCompact(parsedPt)} PT, have {formatCompact(syBalance)} SY +{" "}
                {formatCompact(ptBalance)} PT.
              </span>
            ) : insufficientSy ? (
              <span className="block font-mono text-[10px] font-medium text-error">
                Insufficient SY — need {formatCompact(parsedSy)}, have {formatCompact(syBalance)}.
              </span>
            ) : insufficientPt ? (
              <span className="block font-mono text-[10px] font-medium text-error">
                Insufficient PT — need {formatCompact(parsedPt)}, have {formatCompact(ptBalance)}.{" "}
                <Link
                  href={`/markets/${market}/pt`}
                  className="underline underline-offset-2 hover:text-text"
                >
                  Buy PT first →
                </Link>
              </span>
            ) : null
          }
        />

        {/* PT override — advanced. Hidden unless the user wants to deviate
            from the auto-balanced split. We show it inline as a smaller
            secondary input so it doesn't clutter the default flow. */}
        <details className="mb-3 rounded-lg border border-border bg-white/[0.02] px-3 py-2">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[1.5px] text-textDim">
            Override PT amount
            {ptOverrideStr && (
              <span className="ml-2 text-warning">[custom]</span>
            )}
          </summary>
          <div className="mt-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-textDim">
                PT (raw)
              </span>
              <span className="font-mono text-[10px] text-textDim">
                Bal: {formatCompact(ptBalance)}
                {ptBalance > 0n && (
                  <button
                    type="button"
                    onClick={() => setPtOverrideStr(ptBalance.toString())}
                    className="ml-2 rounded border border-borderHover bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08]"
                  >
                    Max
                  </button>
                )}
              </span>
            </div>
            <input
              type="number"
              value={ptOverrideStr}
              onChange={(e) => setPtOverrideStr(e.target.value)}
              placeholder={suggestedPt > 0n ? suggestedPt.toString() : "auto-balanced"}
              inputMode="decimal"
              className={`w-full rounded-[8px] border bg-bgInput px-3 py-2 font-mono text-[12px] text-text outline-none transition ${
                insufficientPt ? "border-error/60 focus:border-error" : "border-border focus:border-borderHover"
              }`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            />
            <div className="mt-1 flex items-center justify-between">
              <span className="font-mono text-[10px] text-textDim">
                {suggestedPt > 0n
                  ? `Auto-balanced: ${formatCompact(suggestedPt)} PT`
                  : "Enter SY-side first"}
              </span>
              {ptOverrideStr && (
                <button
                  type="button"
                  onClick={() => setPtOverrideStr("")}
                  className="font-mono text-[10px] text-textDim underline underline-offset-2 hover:text-text"
                >
                  reset
                </button>
              )}
            </div>
            {insufficientPt && (
              <span className="mt-1 block font-mono text-[10px] font-medium text-error">
                Insufficient PT.
              </span>
            )}
          </div>
        </details>

        <SectionDivider label="Routing" />

        <SlippageChips
          slippageBps={slippageBps}
          setSlippageBps={setSlippageBps}
          maxBps={500}
        />

        <SectionDivider label="Settlement" />

        <button
          type="button"
          disabled={
            !user ||
            source === "hbar" ||
            noInput ||
            isPending ||
            isConfirmingFinal ||
            insufficientSy ||
            insufficientPt ||
            !routerDeployed ||
            noPt
          }
          onClick={onPrimary}
          className="w-full rounded-[10px] bg-white px-7 py-3.5 font-mono text-sm font-semibold uppercase tracking-[1px] text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!user
            ? "Connect wallet"
            : source === "hbar"
              ? "HBAR mode coming soon"
              : noPt
                ? "You need PT — buy PT first"
                : noInput
                  ? "Enter amounts"
                  : insufficientSy && insufficientPt
                    ? "Insufficient SY + PT"
                    : insufficientSy
                      ? "Insufficient SY"
                      : insufficientPt
                        ? "Insufficient PT"
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
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-textDim">
            Two approvals (SY + PT), then the add-liquidity tx. One HashPack popup each.
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
                  setTxHash(undefined);
                  setWriteError(null);
                  setUsdStr("");
                  setSyRawStr("");
                  setPtOverrideStr("");
                }}
                className="underline underline-offset-2 hover:text-text"
              >
                New deposit
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

/* ─────────────────────────────────────────────────────── Remove */

interface RemoveProps {
  market: `0x${string}`;
  detail: MarketDetail;
  user: `0x${string}` | undefined;
  lpBalance: bigint;
  adapter: ReturnType<typeof useWalletAdapter>;
}

function RemoveLp({ market, detail, user, lpBalance, adapter }: RemoveProps) {
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
  const isPending = isSubmitting || adapter.isWritePending;
  const routerDeployed = isDeployed(ADDRESSES.router);

  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ptRate = ptToSyRate(apy, days);

  // LP-side $-per-unit: LP token represents pro-rata pool share. Value per LP =
  // (SY-share-of-LP × usdPerShare) + (PT-share-of-LP × ptRate × usdPerShare).
  // Returns undefined when no LP supply or no price feed.
  const usdPerLp = useMemo<number | undefined>(() => {
    if (usdPerShare === undefined) return undefined;
    if (detail.lpSupply === 0n) return undefined;
    const syPerLp = Number(detail.totalSy) / Number(detail.lpSupply);
    const ptPerLp = Number(detail.totalPt) / Number(detail.lpSupply);
    return (syPerLp + ptPerLp * ptRate) * usdPerShare;
  }, [usdPerShare, detail.totalSy, detail.totalPt, detail.lpSupply, ptRate]);

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

  const parsedLp = useMemo<bigint>(() => {
    if (inputMode === "usd" && usdPerLp !== undefined) {
      return usdToRawBigInt(usdStr, usdPerLp);
    }
    return parseRawBigInt(rawStr);
  }, [inputMode, usdStr, rawStr, usdPerLp]);

  const insufficientLp = parsedLp > lpBalance;
  const needsLpApprove = parsedLp > 0n && lpAllowance < parsedLp;

  const expectedSy =
    detail.lpSupply > 0n
      ? (parsedLp * detail.totalSy) / detail.lpSupply
      : 0n;
  const expectedPt =
    detail.lpSupply > 0n
      ? (parsedLp * detail.totalPt) / detail.lpSupply
      : 0n;
  const minSyOut = (expectedSy * BigInt(10_000 - slippageBps)) / 10_000n;
  const minPtOut = (expectedPt * BigInt(10_000 - slippageBps)) / 10_000n;

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

  const isActive = isPending || isConfirmingFinal;
  const isDone = isConfirmedFinal;
  const flowSteps: FlowStep[] = [
    {
      label: "You burn",
      detail: "LP shares → Router",
      inToken:
        parsedLp > 0n
          ? {
              sym: "LP",
              amount: formatCompact(parsedLp),
              usd:
                usdPerLp !== undefined
                  ? `≈ $${(Number(parsedLp) * usdPerLp).toFixed(2)}`
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
      label: "removeLiquidityProportional",
      detail: `≤ ${(slippageBps / 100).toFixed(2)}% slippage`,
      isActive: isActive && !isDone,
      isComplete: isDone,
    },
    {
      label: "SY + PT returned",
      detail: `min ${formatCompact(minSyOut)} SY, ${formatCompact(minPtOut)} PT`,
      outToken:
        expectedSy > 0n
          ? {
              sym: "SY",
              amount: `~${formatCompact(expectedSy)}`,
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

  return (
    <div className="flex flex-col gap-3">
      <FlowOfFunds title="Flow of funds · Remove liquidity" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Remove liquidity"
          right={
            <>
              {usdPerLp === undefined && (
                <StatusPill tone="info">Price loading</StatusPill>
              )}
              {needsLpApprove && (
                <StatusPill tone="warning">Needs approval</StatusPill>
              )}
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
          parsedRaw={parsedLp}
          balance={lpBalance}
          tokenSym="LP"
          label="LP to withdraw"
          usdPerUnit={usdPerLp}
          formatRaw={formatCompact}
          insufficient={insufficientLp}
          outputHint={
            parsedLp > 0n ? (
              <span>
                Receive <span className="text-text">~{formatCompact(expectedSy)} SY</span> +{" "}
                <span className="text-text">{formatCompact(expectedPt)} PT</span>
              </span>
            ) : undefined
          }
          minOutHint={
            parsedLp > 0n ? (
              <span>
                Min: <span className="text-text">{formatCompact(minSyOut)} SY</span> +{" "}
                <span className="text-text">{formatCompact(minPtOut)} PT</span>
              </span>
            ) : undefined
          }
          caption={<>gas ~0.10 HBAR</>}
          feedback={
            insufficientLp ? (
              <span className="block font-mono text-[10px] font-medium text-error">
                Insufficient LP — you have {formatCompact(lpBalance)}.
              </span>
            ) : null
          }
        />

        <SectionDivider label="Routing" />

        <SlippageChips
          slippageBps={slippageBps}
          setSlippageBps={setSlippageBps}
          maxBps={500}
        />

        <SectionDivider label="Settlement" />

        <button
          type="button"
          disabled={!user || parsedLp === 0n || isPending || isConfirmingFinal || insufficientLp || !routerDeployed}
          onClick={onPrimary}
          className="w-full rounded-[10px] bg-white px-7 py-3.5 font-mono text-sm font-semibold uppercase tracking-[1px] text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
                  setTxHash(undefined);
                  setWriteError(null);
                  setUsdStr("");
                  setRawStr("");
                }}
                className="underline underline-offset-2 hover:text-text"
              >
                New withdrawal
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── helpers */

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
