"use client";

/**
 * BuyYtForm — extracted from the previous TradeCard "yt" branch on the
 * market detail page. Single SY (or HBAR) input → router.buyYT → receive YT
 * to the connected account (any unused SY budget is refunded).
 *
 * 2026-05-14 (auto-mint): adds the same HBAR-mode chain as BuyPtForm:
 *   1. Associate (SY-share / WHBAR / YT) — single batched HashPack popup
 *   2. Zap HBAR → SY                      — `zapHbarToSy`
 *   3. Approve SY for Router              — only when allowance < SY-out
 *   4. Buy YT                             — `buyYT`
 *
 * Post-zap SY-balance reads are Hashio-lag-aware (5× 1s retries) so the
 * approve + buy use the chain-observed delta, not the UI estimate.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, http } from "viem";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { hederaMainnet } from "@/lib/chains";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate, ytToSyRate } from "@/components/MarketPositionCard";
import { useSyValueUsd, useHbarUsd } from "@/hooks/useSyValueUsd";
import { ADDRESSES, HEDERA_TOKENS, isDeployed, MAX_HTS_APPROVE } from "@/lib/addresses";
import { lensAbi } from "@/lib/abis";
import { readLiveTradeCap } from "@/lib/trade-cap";
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

type Source = "hbar" | "sy";

type FlowState =
  | { kind: "idle" }
  | { kind: "associating"; stepIdx: 1 }
  | { kind: "zapping"; stepIdx: 2 }
  | { kind: "zapped"; syAcquired: bigint; stepIdx: 3 }
  | { kind: "approving"; stepIdx: 3 }
  | { kind: "approved"; syAcquired: bigint; stepIdx: 4 }
  | { kind: "buying"; stepIdx: 4 }
  // MegaZap single-tx HBAR → YT.
  | { kind: "megaZapping"; stepIdx: 0 }
  | { kind: "done"; finalTxHash: string }
  | { kind: "error"; message: string; failedAt: number; syAcquired?: bigint };

export function BuyYtForm({ market, detail, user, syBalance }: Props) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const { usdPerShare } = useSyValueUsd(detail.sy);
  const hbarUsd = useHbarUsd();

  const [source] = useState<Source>("hbar");
  const zapAvailable = isDeployed(ADDRESSES.periphery);
  // MegaZap.zapHbarToYt is STRUCTURALLY over Hedera's 50-child consensus
  // limit: the YT path adds split-mint-PT/YT + YT freeze + extra AMM
  // transfers over the PT path, pushing total child records past 50 every
  // time (live capture 1779722382: hit exactly 50 + MAX_CHILD_RECORDS).
  // Buy PT lands at 50 children and is fine; Buy YT cannot fit.
  //
  // So Buy YT always uses the chain: zap HBAR → SY (FissionZap),
  // then SY → YT (Router.buyYT). 2 popups in steady state (3 first-time
  // if infinite SY allowance hasn't been granted yet). Deterministic, no
  // failed retries.
  //
  // For a real atomic 1-tx Buy YT we'd need MegaZap v2 with constructor-
  // baked int64.max approvals to the Router + SY + V2 SwapRouter, which
  // drops ~5-7 runtime CRYPTOAPPROVEALLOWANCE children. That's a contract
  // redeploy — track separately.
  const megaZapAvailable = false;
  const effectiveSource: Source = zapAvailable ? source : "sy";

  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [rawStr, setRawStr] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);

  const [flowState, setFlowState] = useState<FlowState>({ kind: "idle" });
  const [lastTxHash, setLastTxHash] = useState<string | undefined>(undefined);
  const [writeError, setWriteError] = useState<string | null>(null);

  const useWagmiReceipt = adapter.mode === "evm";
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: useWagmiReceipt ? (lastTxHash as `0x${string}` | undefined) : undefined,
    query: { enabled: useWagmiReceipt && !!lastTxHash && lastTxHash.startsWith("0x") },
  });
  const isConfirmingFinal = useWagmiReceipt ? isConfirming : false;
  const routerDeployed = isDeployed(ADDRESSES.periphery);
  // `isPending` controls button-disable + spinner labels. CRITICAL: this
  // must also be true during the SHORT inter-step states (`zapped`,
  // `approved`) — those are the transitions BETWEEN wallet popups in the
  // 2/4-step chain. Without them the button reverts to the idle label and
  // a user re-press fires a second parallel chain. Live capture
  // 1779723347→1779723377: user double-bought YT for exactly that reason.
  const isPending =
    adapter.isWritePending ||
    flowState.kind === "associating" ||
    flowState.kind === "zapping" ||
    flowState.kind === "zapped" ||
    flowState.kind === "approving" ||
    flowState.kind === "approved" ||
    flowState.kind === "buying" ||
    flowState.kind === "megaZapping";

  /* ─────────────────────────── parsed amounts */

  const hbarAmount = useMemo<number>(() => {
    if (effectiveSource !== "hbar") return 0;
    if (inputMode === "usd" && hbarUsd !== undefined) {
      const usd = parseFloat(usdStr.replace(/,/g, ""));
      if (!Number.isFinite(usd) || usd <= 0) return 0;
      return usd / hbarUsd;
    }
    const n = parseFloat(rawStr);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [effectiveSource, inputMode, usdStr, rawStr, hbarUsd]);

  const parsedSy = useMemo<bigint>(() => {
    if (effectiveSource !== "sy") return 0n;
    if (inputMode === "usd" && usdPerShare !== undefined) {
      return usdToRawBigInt(usdStr, usdPerShare);
    }
    return parseRawBigInt(rawStr);
  }, [effectiveSource, inputMode, usdStr, rawStr, usdPerShare]);

  const estimatedSyFromHbar = useMemo<bigint>(() => {
    if (effectiveSource !== "hbar") return 0n;
    if (hbarAmount <= 0 || usdPerShare === undefined || hbarUsd === undefined) return 0n;
    const usdValue = hbarAmount * hbarUsd;
    const raw = Math.floor(usdValue / Math.max(1e-12, usdPerShare));
    return raw > 0 ? BigInt(raw) : 0n;
  }, [effectiveSource, hbarAmount, hbarUsd, usdPerShare]);

  const syForSwap: bigint = useMemo(() => {
    if (effectiveSource === "sy") return parsedSy;
    if (flowState.kind === "zapped" || flowState.kind === "approving" || flowState.kind === "approved" || flowState.kind === "buying") {
      return (flowState as { syAcquired: bigint }).syAcquired;
    }
    return estimatedSyFromHbar;
  }, [effectiveSource, parsedSy, estimatedSyFromHbar, flowState]);

  const insufficient = effectiveSource === "sy" && parsedSy > syBalance;
  const needsSy = effectiveSource === "sy" && syBalance === 0n;
  const sizeLimit = computeSizeLimit(syForSwap, detail.totalSy, detail.totalPt);

  // F8: mirror the periphery's own size cap (maxTradeBps = 5% of totalSy,
  // checked against syIn) on the HBAR path so an oversized zap doesn't sail
  // through to a TradeExceedsCap revert. 500 bps matches the contract default.
  const CONTRACT_MAX_TRADE_BPS = 500n;
  const contractTradeCap =
    detail.totalSy > 0n ? (detail.totalSy * CONTRACT_MAX_TRADE_BPS) / 10_000n : 0n;
  const hbarExceedsContractCap =
    effectiveSource === "hbar" && contractTradeCap > 0n && syForSwap > contractTradeCap;

  /* ─────────────────────────── YT estimate */

  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ytRate = ytToSyRate(apy, days);
  const ytEstimateNum =
    syForSwap > 0n && ytRate > 0
      ? Number(syForSwap) / Math.max(1e-9, ytRate)
      : 0;
  const ytEstimate = ytEstimateNum > 0 ? BigInt(Math.floor(ytEstimateNum)) : 0n;
  const minYtOut = (ytEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

  /* ─────────────────────────── allowance + SY balance reads */

  const spender: `0x${string}` = ADDRESSES.periphery;
  const allowanceRead = useReadContracts({
    contracts:
      user && detail.syShare
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
          ]
        : [],
    query: { enabled: !!user },
    allowFailure: true,
  });
  const allowance =
    allowanceRead.data?.[0]?.status === "success"
      ? (allowanceRead.data[0].result as bigint)
      : 0n;
  const onChainSyBalance =
    allowanceRead.data?.[1]?.status === "success"
      ? (allowanceRead.data[1].result as bigint)
      : syBalance;

  const needsApprove = syForSwap > 0n && allowance < syForSwap;

  /* ─────────────────────────── helpers + step runners */

  const setStatus = useCallback((next: FlowState) => setFlowState(next), []);

  const readPostZapSyBalance = useCallback(
    async (preZapSy: bigint, fallback: bigint): Promise<bigint> => {
      for (let i = 0; i < 5; i++) {
        try {
          const r = await allowanceRead.refetch();
          const fresh =
            r.data?.[1]?.status === "success"
              ? (r.data[1].result as bigint)
              : preZapSy;
          if (fresh > preZapSy) return fresh - preZapSy;
        } catch {
          /* retry */
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      return fallback;
    },
    [allowanceRead],
  );

  const stepAssociate = useCallback(
    async (tokens: `0x${string}`[]): Promise<boolean> => {
      try {
        const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
          await import("@/lib/hedera-wallet/associations");
        const ids = tokens.map(evmAddressToTokenId);

        // F8: precheck associations regardless of wallet mode. The EVM path
        // previously assumed HIP-904 auto-assoc always covers it; EVM-aliased
        // accounts with max_automatic_token_associations = 0 silently fail to
        // receive YT / SY shares. Resolve the account id from the EVM address
        // via mirror and verify; HIP-904 unlimited accounts have no missing
        // tokens and pass through unchanged.
        if (adapter.mode !== "hedera" || !adapter.accountId) {
          if (!user) return true;
          const acctId = await resolveAccountIdFromEvm(user);
          if (!acctId) return true;
          const missing = await getMissingAssociations(acctId, ids);
          if (missing.length === 0) return true;
          const msg =
            "Your account isn't set up to receive these tokens (YT / SY share). " +
            "Enable automatic token associations in your wallet, or associate " +
            "them once, then retry.";
          setWriteError(msg);
          setStatus({ kind: "error", message: msg, failedAt: 1 });
          return false;
        }

        const missing = await getMissingAssociations(adapter.accountId, ids);
        if (missing.length === 0) return true;
        setStatus({ kind: "associating", stepIdx: 1 });
        await associateTokens(hedera.getConnector(), adapter.accountId, missing);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setWriteError(msg);
        setStatus({ kind: "error", message: msg, failedAt: 1 });
        return false;
      }
    },
    [adapter.mode, adapter.accountId, hedera, setStatus, user],
  );

  const stepZap = useCallback(
    async (hbarIn: number): Promise<{ ok: true; syAcquired: bigint } | { ok: false }> => {
      setStatus({ kind: "zapping", stepIdx: 2 });
      let preZapSy: bigint = onChainSyBalance;
      try {
        const r = await allowanceRead.refetch();
        if (r.data?.[1]?.status === "success") preZapSy = r.data[1].result as bigint;
      } catch {
        /* fall back */
      }
      try {
        if (!user) throw new Error("No user address");
        const { txHash } = await adapter.write({
          kind: "zapHbarToSy",
          zap: ADDRESSES.periphery,
          sy: detail.sy,
          receiver: user,
          hbarIn,
        });
        setLastTxHash(txHash);
        const acquired = await readPostZapSyBalance(preZapSy, estimatedSyFromHbar);
        setStatus({ kind: "zapped", syAcquired: acquired, stepIdx: 3 });
        return { ok: true, syAcquired: acquired };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setWriteError(msg);
        setStatus({ kind: "error", message: msg, failedAt: 2 });
        return { ok: false };
      }
    },
    [adapter, allowanceRead, detail.sy, estimatedSyFromHbar, onChainSyBalance, readPostZapSyBalance, setStatus, user],
  );

  const stepApprove = useCallback(
    async (amount: bigint, syAcquired: bigint): Promise<boolean> => {
      setStatus({ kind: "approving", stepIdx: 3 });
      try {
        const { txHash } = await adapter.write({
          kind: "approveErc20",
          token: detail.syShare,
          spender,
          // Set-once allowance: every future Buy YT skips the approve prompt.
          amount: MAX_HTS_APPROVE,
        });
        setLastTxHash(txHash);
        await allowanceRead.refetch();
        setStatus({ kind: "approved", syAcquired, stepIdx: 4 });
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setWriteError(msg);
        setStatus({ kind: "error", message: msg, failedAt: 3, syAcquired });
        return false;
      }
    },
    [adapter, allowanceRead, detail.syShare, spender, setStatus],
  );

  const stepBuyYt = useCallback(
    async (syInRaw: bigint): Promise<boolean> => {
      if (!user) return false;
      setStatus({ kind: "buying", stepIdx: 4 });
      // BUY-CAP-01: clamp syIn to the LIVE per-trade cap before the swap so an
      // oversized post-zap SY balance buys the max YT it can instead of
      // reverting TradeExceedsCap and stranding the zapped SY (see
      // readLiveTradeCap). No-op in the normal regime; only fires on the price
      // knife-edge where the pre-zap linear guard undershoots.
      let syIn = syInRaw;
      const liveCap = await readLiveTradeCap(market);
      if (liveCap > 0n && syIn > liveCap) syIn = liveCap;
      // BUY-YT-01: buySyForYt splits `syIn` SY → `syIn` PT + `syIn` YT, then
      // sells the PT for SY (refunded to the user). The market reverts if that
      // PT-sale's SY output < minSyOutFromPtSale. The old JS interest model
      // drifted high and produced an unreachable floor → revert at 10bps.
      // Use the live Lens — previewSwapExactPtForSy(market, syIn) is exactly
      // the PT-sale's SY output, so minSyOut = that × (1 − slippage) is always
      // reachable.
      const minSyOut = await computeMinSyOutForYt(market, syIn, slippageBps);
      // BUYLP-2: on a Lens-read failure computeMinSyOutForYt returns the 0n
      // sentinel. Previously the fallback was minSyOut=1, leaving the PT-resale
      // refund leg with no slippage protection. Abort with a clear error
      // instead of submitting an unprotected trade.
      if (minSyOut <= 0n) {
        const msg = "Price quoter unreachable — couldn't set slippage protection. Please try again in a moment.";
        setWriteError(msg);
        setStatus({ kind: "error", message: msg, failedAt: 4 });
        return false;
      }
      try {
        const { txHash } = await adapter.write({
          kind: "writePeriphery",
          functionName: "buySyForYt",
          args: [market, syIn, minSyOut, user, 0n],
        });
        setLastTxHash(txHash);
        setStatus({ kind: "done", finalTxHash: txHash });
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setWriteError(msg);
        setStatus({ kind: "error", message: msg, failedAt: 4 });
        return false;
      }
    },
    [adapter, market, slippageBps, setStatus, user],
  );

  const hbarFlowTokens: `0x${string}`[] = useMemo(
    () => [detail.syShare, HEDERA_TOKENS.WHBAR, detail.yt],
    [detail.syShare, detail.yt],
  );

  // MegaZap fast-path: HBAR → YT in a single tx.
  const runMegaZapYt = useCallback(
    async (hbarIn: number): Promise<{ ok: true } | { ok: false; fallback: boolean }> => {
      if (!user) return { ok: false, fallback: false };
      setWriteError(null);

      const tokens: `0x${string}`[] = [detail.syShare, HEDERA_TOKENS.WHBAR, detail.yt];
      const okAssoc = await stepAssociate(tokens);
      if (!okAssoc) return { ok: false, fallback: false };

      setStatus({ kind: "megaZapping", stepIdx: 0 });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      // Same PT-sale-aware floor as the router-path: expected SY ≈ syIn · ptRate.
      const ptRate = ptToSyRate(apy, days);
      const expectedSyOut = BigInt(Math.floor(Number(estimatedSyFromHbar) * ptRate));
      const minSyOut = (expectedSyOut * BigInt(10_000 - slippageBps)) / 10_000n;
      try {
        const { txHash } = await adapter.write({
          kind: "zapHbarToYtMega",
          megaZap: ADDRESSES.periphery,
          market,
          sy: detail.sy,
          minSyOutFromPtSale: minSyOut,
          receiver: user,
          deadline,
          hbarIn,
        });
        setLastTxHash(txHash);
        setStatus({ kind: "done", finalTxHash: txHash });
        return { ok: true as const };
      } catch (e) {
        // Hedera SDK throws StatusError as a PLAIN OBJECT with `.status`,
        // NOT a JS Error subclass — `e.message` is empty and the prior
        // `instanceof Error ? e.message : String(e)` returned "[object
        // Object]", which never matched the regex. Live capture from
        // HashPack 2026-05-25 1779722382:
        //   {"name":"StatusError","status":"MAX_CHILD_RECORDS_EXCEEDED",
        //    "transactionId":"…","message":"receipt … contained error …"}
        // Serialize the object so the regex can see `.status`.
        const msg =
          e instanceof Error
            ? `${e.message} ${JSON.stringify({ name: e.name })}`
            : typeof e === "object" && e !== null
              ? JSON.stringify(e)
              : String(e);
        // Fall back to the legacy 4-tx chain for any MegaZap failure that's
        // not user cancellation — covers MAX_CHILD_RECORDS (HashPack), plus
        // Hashio-side rejections (HTTP client error, RPC submit, OOG,
        // insufficient pre-charge). Each leg of the legacy chain has its
        // own 50-record budget + smaller gas envelope and survives where
        // the atomic MegaZap can't.
        const isUserCancel = /User rejected|User denied|user.*reject/i.test(msg);
        const isRecoverable =
          !isUserCancel &&
          /MAX_CHILD_RECORDS|CHILD_RECORDS_EXCEEDED|HTTP client error|insufficient|OUT_OF_GAS|RPC submit/i.test(msg);
        if (isRecoverable) {
          return { ok: false as const, fallback: true as const };
        }
        setWriteError(msg);
        setStatus({ kind: "error", message: msg, failedAt: 0 });
        return { ok: false as const, fallback: false as const };
      }
    },
    [adapter, apy, days, detail.sy, detail.syShare, detail.yt, estimatedSyFromHbar, market, setStatus, slippageBps, stepAssociate, user],
  );

  const runHbarChainFromStep = useCallback(
    async (startStep: number, carrySyAcquired?: bigint) => {
      setWriteError(null);
      let syAcquired: bigint = carrySyAcquired ?? 0n;

      if (startStep <= 1) {
        const ok = await stepAssociate(hbarFlowTokens);
        if (!ok) return;
      }
      if (startStep <= 2) {
        const r = await stepZap(hbarAmount);
        if (!r.ok) return;
        syAcquired = r.syAcquired;
      }
      if (startStep <= 3) {
        const r = await allowanceRead.refetch();
        const currentAllowance =
          r.data?.[0]?.status === "success" ? (r.data[0].result as bigint) : allowance;
        if (currentAllowance < syAcquired) {
          const ok = await stepApprove(syAcquired, syAcquired);
          if (!ok) return;
        } else {
          setStatus({ kind: "approved", syAcquired, stepIdx: 4 });
        }
      }
      if (startStep <= 4) {
        await stepBuyYt(syAcquired);
      }
    },
    [allowance, allowanceRead, hbarAmount, hbarFlowTokens, setStatus, stepApprove, stepAssociate, stepBuyYt, stepZap],
  );

  const runSyChain = useCallback(async () => {
    if (!user || parsedSy === 0n || !routerDeployed) return;
    if (parsedSy > syBalance) return;
    setWriteError(null);

    if (adapter.mode === "hedera" && adapter.accountId) {
      try {
        const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
          await import("@/lib/hedera-wallet/associations");
        const ids = [detail.yt].map(evmAddressToTokenId);
        const missing = await getMissingAssociations(adapter.accountId, ids);
        if (missing.length > 0) {
          setStatus({ kind: "associating", stepIdx: 1 });
          await associateTokens(hedera.getConnector(), adapter.accountId, missing);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setWriteError(msg);
        setStatus({ kind: "error", message: msg, failedAt: 1 });
        return;
      }
    }

    if (needsApprove) {
      const ok = await stepApprove(parsedSy, parsedSy);
      if (!ok) return;
    }
    await stepBuyYt(parsedSy);
  }, [adapter.mode, adapter.accountId, detail.yt, hedera, needsApprove, parsedSy, routerDeployed, setStatus, stepApprove, stepBuyYt, syBalance, user]);

  const onPrimary = useCallback(async () => {
    if (!user) return;
    if (flowState.kind === "error") {
      if (effectiveSource === "hbar" && megaZapAvailable) {
        const r = await runMegaZapYt(hbarAmount);
        if (!r.ok && r.fallback) {
          setWriteError(
            "MegaZap fast-path unavailable at this size (Hedera child-record limit). " +
            "Running the multi-tx chain — please sign each prompt."
          );
          await runHbarChainFromStep(1);
        }
        return;
      }
      const carry = flowState.syAcquired;
      void runHbarChainFromStep(flowState.failedAt, carry);
      return;
    }
    if (effectiveSource === "hbar") {
      if (hbarAmount <= 0 || !zapAvailable) return;
      if (megaZapAvailable) {
        const r = await runMegaZapYt(hbarAmount);
        if (!r.ok && r.fallback) {
          setWriteError(
            "MegaZap fast-path unavailable at this size (Hedera child-record limit). " +
            "Running the multi-tx chain — please sign each prompt."
          );
          await runHbarChainFromStep(1);
        }
      } else {
        void runHbarChainFromStep(1);
      }
    } else {
      void runSyChain();
    }
  }, [effectiveSource, flowState, hbarAmount, megaZapAvailable, runHbarChainFromStep, runMegaZapYt, runSyChain, user, zapAvailable]);

  useEffect(() => {
    if (flowState.kind !== "done" && flowState.kind !== "error") return;
    if (effectiveSource === "hbar" && hbarAmount === 0) {
      setFlowState({ kind: "idle" });
      setLastTxHash(undefined);
      setWriteError(null);
    }
    if (effectiveSource === "sy" && parsedSy === 0n) {
      setFlowState({ kind: "idle" });
      setLastTxHash(undefined);
      setWriteError(null);
    }
  }, [effectiveSource, flowState.kind, hbarAmount, parsedSy]);

  const resetWrite = () => {
    setFlowState({ kind: "idle" });
    setLastTxHash(undefined);
    setWriteError(null);
  };

  /* ─────────────────────────── FlowOfFunds */

  const isActive = isPending || isConfirmingFinal;
  const isDoneFinal = flowState.kind === "done";
  const poolHealthy = !sizeLimit.exceeded && sizeLimit.poolDepth > 0n;

  const stepIsActive = (idx: number): boolean => {
    switch (flowState.kind) {
      case "associating": return idx === 1;
      case "zapping":     return idx === 2;
      case "approving":   return idx === 3;
      case "buying":      return idx === 4;
      default:            return false;
    }
  };
  const stepIsComplete = (idx: number): boolean => {
    if (flowState.kind === "done") return true;
    if (flowState.kind === "error") return idx < flowState.failedAt;
    switch (flowState.kind) {
      case "zapping":   return idx < 2;
      case "zapped":    return idx <= 2;
      case "approving": return idx < 3;
      case "approved":  return idx <= 3;
      case "buying":    return idx < 4;
      default:          return false;
    }
  };

  const flowSteps: FlowStep[] = effectiveSource === "hbar" && megaZapAvailable
    ? [
        {
          label: "Associate tokens",
          detail: adapter.mode === "hedera" ? "HTS one-time setup (SY share, WHBAR, YT)" : "EVM mode — HIP-904 covers it",
          isActive: flowState.kind === "associating",
          isComplete: flowState.kind === "megaZapping" || isDoneFinal,
        },
        {
          label: "Buy YT via MegaZap (1 tx)",
          detail: `${shortAddr(ADDRESSES.periphery)} · HBAR → SY → YT atomically · +5 HBAR NPM fee`,
          inToken:
            hbarAmount > 0
              ? {
                  sym: "HBAR",
                  amount: hbarAmount.toFixed(2),
                  usd: hbarUsd !== undefined ? `≈ $${(hbarAmount * hbarUsd).toFixed(2)}` : undefined,
                }
              : undefined,
          outToken:
            ytEstimate > 0n
              ? {
                  sym: "YT",
                  amount: `~${formatCompact(ytEstimate)}`,
                  usd: `min ${formatCompact(minYtOut)} YT`,
                }
              : undefined,
          isActive: flowState.kind === "megaZapping",
          isComplete: isDoneFinal,
        },
        {
          label: "Your wallet",
          detail: user ? shortAddr(user) : "—",
          isComplete: isDoneFinal,
        },
      ]
    : effectiveSource === "hbar"
    ? [
        {
          label: "Associate tokens",
          detail: adapter.mode === "hedera" ? "HTS one-time setup (SY share, WHBAR, YT)" : "EVM mode — HIP-904 covers it",
          isActive: stepIsActive(1),
          isComplete: stepIsComplete(1),
        },
        {
          label: "Zap HBAR → SY",
          detail: `${shortAddr(ADDRESSES.periphery)} · +5 HBAR NPM fee`,
          inToken:
            hbarAmount > 0
              ? {
                  sym: "HBAR",
                  amount: hbarAmount.toFixed(2),
                  usd: hbarUsd !== undefined ? `≈ $${(hbarAmount * hbarUsd).toFixed(2)}` : undefined,
                }
              : undefined,
          outToken:
            syForSwap > 0n
              ? { sym: "SY", amount: `~${formatCompact(syForSwap)}` }
              : undefined,
          isActive: stepIsActive(2),
          isComplete: stepIsComplete(2),
        },
        {
          label: "Approve SY for Router",
          detail: shortAddr(ADDRESSES.periphery),
          isActive: stepIsActive(3),
          isComplete: stepIsComplete(3),
        },
        {
          label: "Buy YT (buyYT)",
          detail: `Inverse swap · yield accrues now · ≤ ${(slippageBps / 100).toFixed(2)}% slippage`,
          inToken:
            syForSwap > 0n
              ? { sym: "SY", amount: formatCompact(syForSwap) }
              : undefined,
          outToken:
            ytEstimate > 0n
              ? {
                  sym: "YT",
                  amount: `~${formatCompact(ytEstimate)}`,
                  usd: `min ${formatCompact(minYtOut)} YT`,
                }
              : undefined,
          isActive: stepIsActive(4),
          isComplete: stepIsComplete(4),
        },
        {
          label: "Your wallet",
          detail: user ? shortAddr(user) : "—",
          isComplete: isDoneFinal,
        },
      ]
    : [
        {
          label: "You pay",
          detail: "Connected wallet → Router",
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
          isComplete: isDoneFinal,
        },
        {
          label: "Router",
          detail: shortAddr(ADDRESSES.periphery),
          isActive: isActive && !isDoneFinal,
          isComplete: isDoneFinal,
        },
        {
          label: "Fission AMM",
          detail: "Inverse swap (YT leverage)",
          isActive: isActive && !isDoneFinal,
          isComplete: isDoneFinal,
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
          isComplete: isDoneFinal,
        },
        {
          label: "Your wallet",
          detail: user ? shortAddr(user) : "—",
          isComplete: isDoneFinal,
        },
      ];

  const buttonLabel = (): string => {
    if (!user) return "Connect wallet";
    if (effectiveSource === "hbar") {
      if (!zapAvailable) return "Zap not deployed";
      if (hbarAmount === 0) return "Enter amount";
      if (hbarAmount < 6) return "Min 6 HBAR";
      if (hbarExceedsContractCap) return "Trade too large for pool";
      if (megaZapAvailable) {
        if (flowState.kind === "error") return "Retry MegaZap";
        if (flowState.kind === "associating") return "Associating tokens…";
        if (flowState.kind === "megaZapping") return "HBAR → YT (1 tx)…";
        if (flowState.kind === "done") return "✓ Done";
        return "Buy YT via Zap (1 tx)";
      }
      if (flowState.kind === "error") {
        const stepName = ["", "association", "zap", "approve", "buy"][flowState.failedAt] ?? "step";
        return `Retry from ${stepName}`;
      }
      if (flowState.kind === "associating") return "1/2 · Associating tokens…";
      if (flowState.kind === "zapping") return "1/2 · Minting SY from HBAR…";
      if (flowState.kind === "zapped") return "1/2 done · preparing approve…";
      if (flowState.kind === "approving") return "Approving SY for Router…";
      if (flowState.kind === "approved") return "2/2 · preparing Buy YT…";
      if (flowState.kind === "buying") return "2/2 · Buying YT…";
      if (flowState.kind === "done") return "✓ Done";
      return `Buy YT via Zap`;
    }
    if (parsedSy === 0n) return "Enter amount";
    if (insufficient) return "Insufficient SY";
    if (sizeLimit.exceeded) return "Trade too large for pool";
    if (flowState.kind === "error") {
      return flowState.failedAt === 1 ? "Retry association" : flowState.failedAt === 3 ? "Retry approval" : "Retry buy";
    }
    if (flowState.kind === "associating") return "Associating YT…";
    if (flowState.kind === "approving") return "Approving SY for Router…";
    if (flowState.kind === "buying") return "Buying YT…";
    if (flowState.kind === "done") return "✓ Done";
    if (isPending) return "Sign in HashPack…";
    if (isConfirmingFinal) return "Waiting for confirmation…";
    if (needsApprove) return "Approve SY for Router";
    return "Buy YT";
  };

  // HBAR floor = v3NpmFeeBudget (5 HBAR on-chain) + 1 HBAR buffer for actual
  // SY mint. Sub-floor inputs hit AmountZero on-chain — block in UI.
  const hbarBelowFloor = effectiveSource === "hbar" && hbarAmount > 0 && hbarAmount < 6;
  const buttonDisabled =
    !user ||
    isPending ||
    isConfirmingFinal ||
    !routerDeployed ||
    (effectiveSource === "hbar"
      ? hbarAmount === 0 || !zapAvailable || hbarBelowFloor || hbarExceedsContractCap
      : parsedSy === 0n || insufficient || sizeLimit.exceeded);

  return (
    <div className="flex flex-col gap-3">
      <FlowOfFunds title="Flow of funds · Buy YT" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Buy YT"
          right={
            <>
              {(usdPerShare === undefined || (effectiveSource === "hbar" && hbarUsd === undefined)) && (
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

        {!zapAvailable && (
          <div className="mb-3 rounded-[6px] border border-warning/30 bg-warning/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-warning">
            Zap not deployed for this market — using your existing SY shares as input.
          </div>
        )}

        <SectionDivider label="Input" />

        {effectiveSource === "hbar" ? (
          <HbarInput
            inputMode={inputMode}
            setInputMode={setInputMode}
            usdStr={usdStr}
            setUsdStr={setUsdStr}
            rawStr={rawStr}
            setRawStr={setRawStr}
            hbarAmount={hbarAmount}
            hbarUsd={hbarUsd}
            estimatedSy={estimatedSyFromHbar}
            ytEstimate={ytEstimate}
            minYtOut={minYtOut}
            slippageBps={slippageBps}
          />
        ) : (
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
        )}

        {user && needsSy && effectiveSource === "sy" && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-warning">
            <span className="font-semibold">You have 0 SY shares.</span> Switch the
            source to <span className="font-semibold">HBAR</span> above to mint SY +
            buy YT in one flow.
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
          disabled={buttonDisabled}
          onClick={() => void onPrimary()}
          className="w-full rounded-[10px] bg-white px-7 py-3.5 font-mono text-sm font-semibold uppercase tracking-[1px] text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {buttonLabel()}
        </button>

        {effectiveSource === "hbar" && hbarAmount > 0 && flowState.kind === "idle" && (
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-textDim">
            {megaZapAvailable
              ? "One HashPack popup (plus a one-time token-associate if you've never touched SY/YT)."
              : "Up to 4 HashPack popups: associate tokens, zap to SY, approve, buy YT."}
          </p>
        )}

        {writeError && (
          <div className="mt-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-error">
            {flowState.kind === "error" && (
              <div className="mb-1 font-semibold uppercase tracking-[1.5px]">
                Step {flowState.failedAt} failed
              </div>
            )}
            {writeError.slice(0, 240)}
          </div>
        )}

        {flowState.kind === "done" && lastTxHash && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-success">
            <div className="font-semibold uppercase tracking-[1px]">YT acquired.</div>
            <div className="mt-1 break-all text-[10px] text-success/80">
              tx: {lastTxHash.slice(0, 18)}…{lastTxHash.slice(-8)}
            </div>
            <div className="mt-1.5 flex gap-3">
              <a
                href={`https://hashscan.io/mainnet/transaction/${hashscanTxId(lastTxHash)}`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-text"
              >
                View on HashScan
              </a>
              <button
                type="button"
                onClick={() => { resetWrite(); setUsdStr(""); setRawStr(""); }}
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

/* ─────────────────────────────────────────────────────── HBAR-mode input */

function HbarInput({
  inputMode,
  setInputMode,
  usdStr,
  setUsdStr,
  rawStr,
  setRawStr,
  hbarAmount,
  hbarUsd,
  estimatedSy,
  ytEstimate,
  minYtOut,
  slippageBps,
}: {
  inputMode: "usd" | "raw";
  setInputMode: (m: "usd" | "raw") => void;
  usdStr: string;
  setUsdStr: (v: string) => void;
  rawStr: string;
  setRawStr: (v: string) => void;
  hbarAmount: number;
  hbarUsd: number | undefined;
  estimatedSy: bigint;
  ytEstimate: bigint;
  minYtOut: bigint;
  slippageBps: number;
}) {
  const effective = hbarUsd === undefined ? "raw" : inputMode;
  // Periphery reserves 5 HBAR (v3NpmFeeBudget) — block ≤6 HBAR so users
  // see a clear floor instead of AmountZero revert.
  const tooSmall = hbarAmount > 0 && hbarAmount < 6;

  return (
    <label className="mb-3 block">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-textDim">
          You pay
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setInputMode("usd")}
            disabled={hbarUsd === undefined}
            className={`rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] transition disabled:opacity-30 ${
              effective === "usd"
                ? "border-text/60 bg-white/[0.08] text-text"
                : "border-border bg-bgInput text-textDim hover:text-text"
            }`}
          >
            USD
          </button>
          <button
            type="button"
            onClick={() => setInputMode("raw")}
            className={`rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[1px] transition ${
              effective === "raw"
                ? "border-text/60 bg-white/[0.08] text-text"
                : "border-border bg-bgInput text-textDim hover:text-text"
            }`}
          >
            HBAR
          </button>
        </div>
      </div>

      <div
        className={`flex items-stretch rounded-[10px] border bg-bgInput transition ${
          tooSmall
            ? "border-warning/60 focus-within:border-warning"
            : "border-border focus-within:border-borderHover"
        }`}
      >
        {effective === "usd" && (
          <span className="flex items-center pl-3 font-mono text-base text-textDim">$</span>
        )}
        <input
          type="number"
          inputMode="decimal"
          value={effective === "usd" ? usdStr : rawStr}
          onChange={(e) =>
            effective === "usd" ? setUsdStr(e.target.value) : setRawStr(e.target.value)
          }
          placeholder="0.00"
          className="w-full bg-transparent px-3 py-3.5 font-mono text-base text-text outline-none"
          style={{ fontVariantNumeric: "tabular-nums" }}
        />
        {effective === "raw" && (
          <span className="flex items-center pr-3 font-mono text-[12px] text-textDim">HBAR</span>
        )}
      </div>

      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-textDim">
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {hbarAmount > 0 && effective === "usd" ? (
            <>≈ {hbarAmount.toFixed(2)} HBAR</>
          ) : hbarAmount > 0 && hbarUsd !== undefined ? (
            <>≈ ${(hbarAmount * hbarUsd).toFixed(2)}</>
          ) : hbarUsd === undefined ? (
            <span>price loading…</span>
          ) : (
            <>&nbsp;</>
          )}
        </span>
        <span>+5 HBAR NPM fee · gas ~0.30 HBAR</span>
      </div>

      {hbarAmount > 0 && estimatedSy > 0n && (
        <div className="mt-1 font-mono text-[10px] text-textSec">
          <span>{hbarAmount.toFixed(2)} HBAR</span>
          <span className="text-textDim"> → </span>
          <span className="text-text">~{formatCompact(estimatedSy)} SY</span>
          {ytEstimate > 0n && (
            <>
              <span className="text-textDim"> → </span>
              <span className="text-text">~{formatCompact(ytEstimate)} YT</span>
            </>
          )}
        </div>
      )}
      {ytEstimate > 0n && (
        <div className="mt-0.5 font-mono text-[10px] text-textDim">
          Min received <span className="text-text">{formatCompact(minYtOut)} YT</span> ·{" "}
          Slippage ≤ {(slippageBps / 100).toFixed(2)}%
        </div>
      )}

      {tooSmall && (
        <span className="mt-1 block font-mono text-[10px] font-medium text-warning">
          5 HBAR is reserved for the V3 NPM mint fee. Commit ≥6 HBAR so any actually lands in the pool.
        </span>
      )}
    </label>
  );
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/* ─────────────────────────────────────────────────────── lens quoter */

let _lensClient: ReturnType<typeof createPublicClient> | null = null;
function lensClient() {
  if (!_lensClient) {
    _lensClient = createPublicClient({ chain: hederaMainnet, transport: http() });
  }
  return _lensClient;
}

/**
 * BUY-YT-01 fix — compute the PT-resale-leg's minSyOut from the live Lens.
 *
 * buySyForYt sells the PT half for SY and reverts if that SY output is below
 * `minSyOutFromPtSale`. `lens.previewSwapExactPtForSy(market, syIn)` returns
 * exactly that SY output (same MarketMath path), so flooring it by the slippage
 * chip yields a target that's always reachable.
 *
 * BUYLP-2: returns the 0n sentinel when the lens is unreachable (or syIn is
 * non-positive). The caller MUST treat 0n as "abort" rather than submitting an
 * unprotected (minSyOut=1) refund leg.
 */
async function computeMinSyOutForYt(
  market: `0x${string}`,
  syIn: bigint,
  slippageBps: number,
): Promise<bigint> {
  if (syIn <= 0n) return 0n;
  try {
    const syOut = (await lensClient().readContract({
      abi: lensAbi,
      address: ADDRESSES.lens,
      functionName: "previewSwapExactPtForSy",
      args: [market, syIn],
    })) as bigint;
    const floor = (syOut * BigInt(10_000 - slippageBps)) / 10_000n;
    return floor; // 0n if the preview itself returned 0 → caller aborts
  } catch {
    return 0n;
  }
}

/**
 * F6 fix — normalize a Hedera consensus tx-id (`0.0.X@S.NS`) into the dash form
 * HashScan's URL accepts (`0.0.X-S-NS`). The account keeps its dots; only the
 * timestamp's seconds.nanos dot becomes a dash. EVM hashes pass through.
 */
function hashscanTxId(raw: string): string {
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  const acct = raw.slice(0, at);
  const ts = raw.slice(at + 1);
  return `${acct}-${ts.replace(".", "-")}`;
}

/**
 * F8 helper — resolve a `0.0.X` Hedera account id from an EVM address via the
 * mirror node, so the EVM/injected path can run the same association precheck
 * the Hedera path does. Returns null if the mirror can't map it.
 */
async function resolveAccountIdFromEvm(evm: `0x${string}`): Promise<string | null> {
  try {
    const r = await fetch(
      `https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evm}`,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as { account?: string };
    return data.account ?? null;
  } catch {
    return null;
  }
}
