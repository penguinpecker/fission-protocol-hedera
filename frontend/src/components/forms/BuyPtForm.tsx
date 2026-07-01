"use client";

/**
 * BuyPtForm — extracted from the previous TradeCard "pt" branch on the
 * market detail page. Single SY (or HBAR) input → router.swapExactSyForPt →
 * receive PT to the connected account.
 *
 * 2026-05-14 (auto-mint): adds a SOURCE toggle [HBAR | SY] at the top. In HBAR
 * mode the form chains up to 4 txs front-to-back:
 *
 *   1. Associate (SY-share / WHBAR / PT) — single batched HashPack popup
 *   2. Zap HBAR → SY                     — `zapHbarToSy`
 *   3. Approve SY for Router             — only when allowance < SY-out
 *   4. Buy PT                            — `swapExactSyForPt`
 *
 * Each step awaits its own receipt (the Hedera adapter does this internally;
 * EVM mode would wait via wagmi). On any step failure the state machine pins
 * to `failedAt` so the user can retry from that step without restarting from
 * scratch (so a successful zap doesn't get re-run after a failed approve).
 *
 * Post-zap SY balance: we never trust the on-screen estimate — the V3 swap
 * inside the zap is tick-sensitive, dust drifts. After the zap receipt we
 * refetch the user's SY-share balance and use (post - pre) as the actual
 * `syAcquired`, which feeds the approve + swap legs. Hashio mirror reads
 * lag receipts by 1-2s sometimes, so we poll-refetch up to 5× at 1s
 * intervals until we see the delta materialize.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, encodeFunctionData, decodeFunctionResult } from "viem";
import { hederaReadTransport, mirrorContractRead } from "@/lib/rpc-client";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { hederaMainnet } from "@/lib/chains";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate } from "@/components/MarketPositionCard";
import { useSyValueUsd, useHbarUsd } from "@/hooks/useSyValueUsd";
import { ADDRESSES, HEDERA_TOKENS, isDeployed, MAX_HTS_APPROVE } from "@/lib/addresses";
import { lensAbi } from "@/lib/abis";
import { readLiveTradeCap, maxPtBuyable } from "@/lib/trade-cap";
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

/* ─────────────────────────────────────────────────────── state machine */

type Source = "hbar" | "sy";

/**
 * Discriminated state for the HBAR-mode chain. SY-mode keeps the simpler
 * pre-existing flow and ignores most of this.
 *
 * `stepIdx` is 1-based so it matches the human-readable "Step 1/4" labels.
 */
type FlowState =
  | { kind: "idle" }
  | { kind: "associating"; stepIdx: 1 }
  | { kind: "zapping"; stepIdx: 2 }
  | { kind: "zapped"; syAcquired: bigint; stepIdx: 3 }
  | { kind: "approving"; stepIdx: 3 }
  | { kind: "approved"; syAcquired: bigint; stepIdx: 4 }
  | { kind: "buying"; stepIdx: 4 }
  // MegaZap single-tx path. `stepIdx` 0 distinguishes it from the multi-step
  // chain so the UI can render a different label without checking ADDRESSES.
  | { kind: "megaZapping"; stepIdx: 0 }
  | { kind: "done"; finalTxHash: string }
  | { kind: "error"; message: string; failedAt: number; syAcquired?: bigint };

/* ─────────────────────────────────────────────────────── component */

export function BuyPtForm({ market, detail, user, syBalance }: Props) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const { usdPerShare } = useSyValueUsd(detail.sy);
  const hbarUsd = useHbarUsd();

  // Source toggle. Default HBAR for the common "I only have HBAR" case.
  const [source] = useState<Source>("hbar");
  const zapAvailable = isDeployed(ADDRESSES.periphery);
  // MegaZap was riding the cliff of Hedera's 50-child consensus limit for
  // Buy PT (51 records — parent + 50 children). As the V3 NFT crosses more
  // ticks (pool state drifts with every swap) the child count tips past
  // the limit. Live capture 2026-05-25: 7 of the last 8 PT MegaZap calls
  // failed with MAX_CHILD_RECORDS_EXCEEDED.
  //
  // Same fix as Buy YT: route HBAR-source through the 2-tx chain
  // (FissionZap.zapHbarToSy → Router.swapExactSyForPt). 2 popups steady-
  // state, 3-4 first-time. Deterministic, no failed retries.
  //
  // For a real atomic 1-tx Buy PT we'd need MegaZap v2 with constructor-
  // baked int64.max approvals — drops the 9 runtime CRYPTOAPPROVEALLOWANCE
  // children. That's a contract redeploy.
  const megaZapAvailable = false;
  // If the zap contract isn't deployed in this env, force SY mode silently.
  const effectiveSource: Source = zapAvailable ? source : "sy";

  // Shared input state. The interpretation of `usdStr` / `rawStr` depends on
  // mode: SY-mode treats them as raw SY (legacy); HBAR-mode treats `usdStr`
  // as USD and `rawStr` as raw HBAR.
  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [rawStr, setRawStr] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);

  // Chain state.
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
  // `isPending` must include the inter-step states (`zapped`, `approved`)
  // so the button stays disabled BETWEEN wallet popups in the chain.
  // Otherwise the user can double-press and fire a parallel chain.
  const isPending =
    adapter.isWritePending ||
    flowState.kind === "associating" ||
    flowState.kind === "zapping" ||
    flowState.kind === "zapped" ||
    flowState.kind === "approving" ||
    flowState.kind === "approved" ||
    flowState.kind === "buying" ||
    flowState.kind === "megaZapping";

  /* ─────────────────────────── parsed amounts (mode-dependent) */

  // Effective HBAR amount (whole HBAR, float). Only meaningful in HBAR mode.
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

  // SY-mode raw amount (legacy path).
  const parsedSy = useMemo<bigint>(() => {
    if (effectiveSource !== "sy") return 0n;
    if (inputMode === "usd" && usdPerShare !== undefined) {
      return usdToRawBigInt(usdStr, usdPerShare);
    }
    return parseRawBigInt(rawStr);
  }, [effectiveSource, inputMode, usdStr, rawStr, usdPerShare]);

  // Estimated SY received from a HBAR zap, used for input preview + slippage
  // floors before the zap actually runs. Real number after zap comes from a
  // chain refetch (see `readPostZapSyBalance` below).
  const estimatedSyFromHbar = useMemo<bigint>(() => {
    if (effectiveSource !== "hbar") return 0n;
    if (hbarAmount <= 0 || usdPerShare === undefined || hbarUsd === undefined) return 0n;
    const usdValue = hbarAmount * hbarUsd;
    const raw = Math.floor(usdValue / Math.max(1e-12, usdPerShare));
    return raw > 0 ? BigInt(raw) : 0n;
  }, [effectiveSource, hbarAmount, hbarUsd, usdPerShare]);

  // Canonical "SY in" the downstream router call will see. In HBAR mode this
  // is the estimate until the zap has actually run, then we substitute the
  // chain-observed `syAcquired`. In SY mode it's just `parsedSy`.
  const syForSwap: bigint = useMemo(() => {
    let raw: unknown;
    if (effectiveSource === "sy") {
      raw = parsedSy;
    } else if (
      flowState.kind === "zapped" ||
      flowState.kind === "approving" ||
      flowState.kind === "approved" ||
      flowState.kind === "buying"
    ) {
      raw = (flowState as { syAcquired: bigint }).syAcquired;
    } else {
      raw = estimatedSyFromHbar;
    }
    // Defensive coercion: this value is typed bigint, but the flowState.syAcquired
    // branch is a chain-read cast that can arrive as a JS number at runtime. The
    // bigint arithmetic below (computeSizeLimit, formatCompact's `x / TOKEN_ONE`)
    // then throws "Cannot mix BigInt and other types" and white-screens the page.
    // Normalize to bigint here so every downstream consumer is safe; value preserved.
    if (typeof raw === "bigint") return raw;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.trunc(n)) : 0n;
  }, [effectiveSource, parsedSy, estimatedSyFromHbar, flowState]);

  const insufficient = effectiveSource === "sy" && parsedSy > syBalance;
  const needsSy = effectiveSource === "sy" && syBalance === 0n;
  const sizeLimit = computeSizeLimit(syForSwap, detail.totalSy, detail.totalPt);

  // SELF-ADAPTING PT CAP (2026-05-31): read the LIVE per-trade PT cap (the smaller
  // of the contract maxTradeBps cap and the 1% pool-depth slippage gate) instead
  // of a stale hardcoded 500n. Drives the HBAR-path guard + the "$ max" shown to
  // the user, and self-adapts to the pool + owner-set bps. Debounced; on read
  // failure the guard is inert (the submit-time readLiveTradeCap clamp backstops).
  const [maxPtSyIn, setMaxPtSyIn] = useState<bigint>(0n);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void maxPtBuyable(market).then((v) => {
        if (!cancelled) setMaxPtSyIn(v);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [market]);
  const hbarExceedsContractCap =
    effectiveSource === "hbar" && maxPtSyIn > 0n && syForSwap > maxPtSyIn;
  // Live max PT a single buy can take, in USD ($ = raw SY-in × usdPerShare; PT≈1:1 SY).
  const maxPtUsd =
    maxPtSyIn > 0n && usdPerShare !== undefined ? Number(maxPtSyIn) * usdPerShare : undefined;

  /* ─────────────────────────── PT estimate + slippage floor */

  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ptRate = ptToSyRate(apy, days);
  const ptEstimateNum =
    syForSwap > 0n && ptRate > 0
      ? Number(syForSwap) / Math.max(1e-9, ptRate)
      : 0;
  const ptEstimate = ptEstimateNum > 0 ? BigInt(Math.floor(ptEstimateNum)) : 0n;
  const minPtOut = (ptEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

  // FIXED-APY (size-aware). The rate a PT buyer actually LOCKS is set by their
  // own fill, not the spot implied APY: a large buy pushes PT's price up, so the
  // locked rate sits below the headline. Ask the Lens what THIS ptEstimate truly
  // costs in SY (curve + the buyer's own slippage), then annualize PT/SY to
  // maturity — PT redeems ~1:1 for SY (rewards-SY exchangeRate = 1). Equals the
  // implied APY for tiny buys; drops below it for large buys on a thin pool.
  const fixedApyRead = useReadContracts({
    contracts:
      isDeployed(ADDRESSES.lens) && ptEstimate > 0n
        ? [
            {
              abi: lensAbi,
              address: ADDRESSES.lens,
              functionName: "previewSwapExactSyForPt",
              args: [market, ptEstimate],
            } as const,
          ]
        : [],
    query: { enabled: isDeployed(ADDRESSES.lens) && ptEstimate > 0n },
    allowFailure: true,
  });
  const syUsedForEstimate =
    fixedApyRead.data?.[0]?.status === "success"
      ? (fixedApyRead.data[0].result as bigint)
      : undefined;
  const lockedFixedApy =
    syUsedForEstimate !== undefined && syUsedForEstimate > 0n && ptEstimate > 0n && days > 0
      ? ((Number(ptEstimate) / Number(syUsedForEstimate)) ** (365 / days) - 1) * 100
      : undefined;
  // Copy fragment reused in the flow steps: shows the locked fixed rate when the
  // live quote is available, otherwise nothing (falls back to the impl-APY line).
  const fixedApyTag =
    lockedFixedApy !== undefined ? `locks ~${lockedFixedApy.toFixed(2)}% fixed · ` : "";

  /* ─────────────────────────── SY allowance (SY-mode + post-zap approve) */

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
            // User's SY share balance — read separately (vs. the syBalance
            // prop which is the parent's snapshot) so we can refetch it
            // inline after the zap step settles.
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

  /* ─────────────────────────── helpers */

  const setStatus = useCallback((next: FlowState) => {
    setFlowState(next);
  }, []);

  // Read post-zap SY balance: Hashio mirror lag means the immediate refetch
  // can return the pre-zap value. Retry up to 5× at 1s intervals comparing
  // to the snapshot we took before submitting the zap. Returns the actual
  // delta (post - pre); falls back to the estimate if we never see movement.
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
          /* swallow + retry */
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      return fallback;
    },
    [allowanceRead],
  );

  /* ─────────────────────────── individual step runners */

  // Each step runner returns true on success / false on failure, sets state,
  // and surfaces errors via setWriteError. They never throw — the chain
  // orchestrator (`runChainFromStep`) reads the flow state to decide whether
  // to advance.

  const stepAssociate = useCallback(
    async (tokens: `0x${string}`[]): Promise<boolean> => {
      try {
        const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
          await import("@/lib/hedera-wallet/associations");
        const ids = tokens.map(evmAddressToTokenId);

        // F10: precheck associations regardless of wallet mode. Previously the
        // EVM path returned early on the assumption that HIP-904 auto-assoc
        // always covers it — but EVM-aliased accounts created with
        // max_automatic_token_associations = 0 silently fail to receive PT/SY
        // shares, surfacing as an opaque delivery revert. Resolve the account
        // id from the EVM address via mirror and verify; HIP-904 unlimited
        // accounts return no missing tokens and pass through untouched.
        if (adapter.mode !== "hedera" || !adapter.accountId) {
          if (!user) return true;
          const acctId = await resolveAccountIdFromEvm(user);
          if (!acctId) return true; // can't resolve → let HIP-904 / on-chain handle it
          const missing = await getMissingAssociations(acctId, ids);
          if (missing.length === 0) return true;
          // The injected/EVM signer can't submit a Hedera
          // TokenAssociateTransaction. Tell the user to associate (or enable
          // auto-association) rather than letting the buy revert on delivery.
          const msg =
            "Your account isn't set up to receive these tokens (PT / SY share). " +
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
      // Snapshot pre-zap SY balance so we can compute the delta after.
      let preZapSy: bigint = onChainSyBalance;
      try {
        const r = await allowanceRead.refetch();
        if (r.data?.[1]?.status === "success") preZapSy = r.data[1].result as bigint;
      } catch {
        /* fall back to cached value */
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
        // Read actual SY received from chain (Hashio lag-aware).
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
          // Set-once allowance: every future Buy PT skips the approve prompt.
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

  const stepBuyPt = useCallback(
    async (syInRaw: bigint): Promise<boolean> => {
      if (!user) return false;
      setStatus({ kind: "buying", stepIdx: 4 });
      // BUY-CAP-01: clamp syIn to the LIVE per-trade cap before the swap so an
      // oversized post-zap SY balance buys the max PT it can instead of
      // reverting TradeExceedsCap and stranding the zapped SY (see
      // readLiveTradeCap). No-op in the normal regime (the pre-zap guard keeps
      // syIn well under the cap); only fires on the price knife-edge.
      // Defensive: syInRaw can arrive as a JS number (it rides flowState.syAcquired,
      // a chain-read cast). computePtOutForBudget below does `syIn * BigInt(...)`,
      // which throws "Cannot mix BigInt and other types" on a number. Coerce up
      // front; value preserved.
      let syIn = typeof syInRaw === "bigint"
        ? syInRaw
        : Number.isFinite(Number(syInRaw)) && Number(syInRaw) > 0
          ? BigInt(Math.trunc(Number(syInRaw)))
          : 0n;
      const liveCap = await readLiveTradeCap(market);
      if (liveCap > 0n && syIn > liveCap) syIn = liveCap;
      // BUY-PT-01/F4: buySyForPt(market, syIn, minPtOut, receiver, deadline)
      // treats the 3rd arg as the EXACT ptOut to mint while capping spend at
      // syIn — the curve reverts if it needs > syIn SY for that ptOut.
      // Tightening slippage with the old JS interest model RAISED the exact-
      // out ask, pushing the curve cost past the budget → revert at 10/25bps.
      // Invert the live Lens instead: pick the largest ptOut whose preview
      // cost fits the slippage-adjusted budget. Cost is then guaranteed
      // <= syIn, so the curve always accepts it.
      const exactPtOut = await computePtOutForBudget(market, syIn, slippageBps);
      // BUYLP-1: when the Lens quoter is unreachable (RPC blocked/throttled) it
      // returns 0n. Submitting a 0n/1n ptOut reverts InsufficientOutput() and
      // surfaces as a confusing "Step 4 failed". Abort BEFORE submitting with a
      // clear, actionable message instead.
      if (exactPtOut <= 0n) {
        const msg = "Price quoter unreachable — couldn't size your PT output. Please try again in a moment.";
        setWriteError(msg);
        setStatus({ kind: "error", message: msg, failedAt: 4 });
        return false;
      }
      try {
        const { txHash } = await adapter.write({
          kind: "writePeriphery",
          functionName: "buySyForPt",
          args: [market, syIn, exactPtOut, user, 0n],
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

  /* ─────────────────────────── chain orchestrators */

  // Hedera tokens that the HBAR flow needs to receive: SY share (from zap),
  // PT (from final swap), and WHBAR (the zap leaves dust on rare paths).
  const hbarFlowTokens: `0x${string}`[] = useMemo(
    () => [detail.syShare, HEDERA_TOKENS.WHBAR, detail.pt],
    [detail.syShare, detail.pt],
  );

  // MegaZap fast-path: HBAR → PT in a single tx. Still pre-associates the
  // destination HTS tokens (PT for the user, plus the SY-share and WHBAR
  // that the MegaZap might emit dust against) — association is a wallet
  // operation, not a contract one, so it can't be folded into the same tx.
  const runMegaZapPt = useCallback(
    async (hbarIn: number): Promise<{ ok: true } | { ok: false; fallback: boolean }> => {
      if (!user) return { ok: false, fallback: false };
      setWriteError(null);

      // Step 0 (off-chain): associate destination tokens if needed.
      const tokens: `0x${string}`[] = [detail.syShare, HEDERA_TOKENS.WHBAR, detail.pt];
      const okAssoc = await stepAssociate(tokens);
      if (!okAssoc) return { ok: false, fallback: false };

      setStatus({ kind: "megaZapping", stepIdx: 0 });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      // Conservative min-PT floor: ptEstimate × (1 − slippage). The MegaZap
      // sweeps any leftover SY back to the user, so even tight floors are
      // safe.
      const minPtOut = (ptEstimate * BigInt(10_000 - slippageBps)) / 10_000n;
      try {
        const { txHash } = await adapter.write({
          kind: "zapHbarToPtMega",
          megaZap: ADDRESSES.periphery,
          market,
          sy: detail.sy,
          minPtOut: minPtOut > 0n ? minPtOut : 1n,
          receiver: user,
          deadline,
          hbarIn,
        });
        setLastTxHash(txHash);
        setStatus({ kind: "done", finalTxHash: txHash });
        return { ok: true as const };
      } catch (e) {
        // Hedera SDK throws StatusError as a PLAIN OBJECT — not an Error
        // subclass. Serialize so the regex sees `.status`. See BuyYtForm
        // for the live capture that motivated this.
        const msg =
          e instanceof Error
            ? `${e.message} ${JSON.stringify({ name: e.name })}`
            : typeof e === "object" && e !== null
              ? JSON.stringify(e)
              : String(e);
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
    [adapter, detail.pt, detail.sy, detail.syShare, market, ptEstimate, setStatus, slippageBps, stepAssociate, user],
  );

  const runHbarChainFromStep = useCallback(
    async (startStep: number, carrySyAcquired?: bigint) => {
      setWriteError(null);

      let syAcquired: bigint = carrySyAcquired ?? 0n;

      // Step 1: Associate.
      if (startStep <= 1) {
        const ok = await stepAssociate(hbarFlowTokens);
        if (!ok) return;
      }

      // Step 2: Zap HBAR → SY.
      if (startStep <= 2) {
        const r = await stepZap(hbarAmount);
        if (!r.ok) return;
        syAcquired = r.syAcquired;
      }

      // Step 3: Approve SY (if allowance insufficient).
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

      // Step 4: Swap.
      if (startStep <= 4) {
        await stepBuyPt(syAcquired);
      }
    },
    [allowance, allowanceRead, hbarAmount, hbarFlowTokens, setStatus, stepApprove, stepAssociate, stepBuyPt, stepZap],
  );

  // Legacy SY-mode trade flow — just associate PT then either approve or buy.
  const runSyChain = useCallback(async () => {
    if (!user || parsedSy === 0n || !routerDeployed) return;
    if (parsedSy > syBalance) return;
    setWriteError(null);

    // Pre-flight HTS association for PT (PT is delivered to the user).
    if (adapter.mode === "hedera" && adapter.accountId) {
      try {
        const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
          await import("@/lib/hedera-wallet/associations");
        const ids = [detail.pt].map(evmAddressToTokenId);
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
    await stepBuyPt(parsedSy);
  }, [adapter.mode, adapter.accountId, detail.pt, hedera, needsApprove, parsedSy, routerDeployed, setStatus, stepApprove, stepBuyPt, syBalance, user]);

  /* ─────────────────────────── primary handler */

  const onPrimary = useCallback(async () => {
    if (!user) return;
    if (flowState.kind === "error") {
      // Retry. MegaZap path: retry the single-tx fast-path; if it hits
      // the child-records ceiling, transparently fall back to the
      // legacy chain. Legacy chain: resume from the failed step.
      if (effectiveSource === "hbar" && megaZapAvailable) {
        const r = await runMegaZapPt(hbarAmount);
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
        const r = await runMegaZapPt(hbarAmount);
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
  }, [effectiveSource, flowState, hbarAmount, megaZapAvailable, runHbarChainFromStep, runMegaZapPt, runSyChain, user, zapAvailable]);

  // Reset flow state when the user switches mode or clears their input — so
  // the "Retry from step N" button doesn't linger on a different trade.
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

  /* ─────────────────────────── FlowOfFunds steps */

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
      case "zapping":    return idx < 2;
      case "zapped":     return idx <= 2;
      case "approving":  return idx < 3;
      case "approved":   return idx <= 3;
      case "buying":     return idx < 4;
      default:           return false;
    }
  };

  // MegaZap path renders a simpler 2-step flow (associate + single MegaZap tx);
  // legacy chain keeps the 4-step layout so users can see retry progress.
  const flowSteps: FlowStep[] = effectiveSource === "hbar" && megaZapAvailable
    ? [
        {
          label: "Associate tokens",
          detail: adapter.mode === "hedera" ? "HTS one-time setup (SY share, WHBAR, PT)" : "EVM mode — HIP-904 covers it",
          isActive: flowState.kind === "associating",
          isComplete: flowState.kind === "megaZapping" || isDoneFinal,
        },
        {
          label: "Buy PT via MegaZap (1 tx)",
          detail: `${shortAddr(ADDRESSES.periphery)} · HBAR → SY → PT atomically · +5 HBAR NPM fee`,
          inToken:
            hbarAmount > 0
              ? {
                  sym: "HBAR",
                  amount: hbarAmount.toFixed(2),
                  usd: hbarUsd !== undefined ? `≈ $${(hbarAmount * hbarUsd).toFixed(2)}` : undefined,
                }
              : undefined,
          outToken:
            ptEstimate > 0n
              ? {
                  sym: "PT",
                  amount: `~${formatCompact(ptEstimate)}`,
                  usd: `min ${formatCompact(minPtOut)} PT`,
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
          detail: adapter.mode === "hedera" ? "HTS one-time setup (SY share, WHBAR, PT)" : "EVM mode — HIP-904 covers it",
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
          label: "Buy PT (swapExactSyForPt)",
          detail: `${fixedApyTag}${apy.toFixed(2)}% impl APY · ≤ ${(slippageBps / 100).toFixed(2)}% slippage`,
          inToken:
            syForSwap > 0n
              ? { sym: "SY", amount: formatCompact(syForSwap) }
              : undefined,
          outToken:
            ptEstimate > 0n
              ? {
                  sym: "PT",
                  amount: `~${formatCompact(ptEstimate)}`,
                  usd: `min ${formatCompact(minPtOut)} PT`,
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
          detail: `swapExactSyForPt · ${fixedApyTag}${apy.toFixed(2)}% impl APY`,
          isActive: isActive && !isDoneFinal,
          isComplete: isDoneFinal,
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
    if (effectiveSource === "hbar") {
      if (!zapAvailable) return "Zap not deployed";
      if (hbarAmount === 0) return "Enter amount";
      if (hbarAmount < 6) return "Min 6 HBAR";
      if (hbarExceedsContractCap) return "Trade too large for pool";
      if (megaZapAvailable) {
        // Fast path. The MegaZap is a single contract call — at most one
        // associate popup beforehand on Hedera mode.
        if (flowState.kind === "error") return "Retry MegaZap";
        if (flowState.kind === "associating") return "Associating tokens…";
        if (flowState.kind === "megaZapping") return "HBAR → PT (1 tx)…";
        if (flowState.kind === "done") return "✓ Done";
        return "Buy PT via Zap (1 tx)";
      }
      if (flowState.kind === "error") {
        const stepName = ["", "association", "zap", "approve", "buy"][flowState.failedAt] ?? "step";
        return `Retry from ${stepName}`;
      }
      if (flowState.kind === "associating") return "1/2 · Associating tokens…";
      if (flowState.kind === "zapping") return "1/2 · Minting SY from HBAR…";
      if (flowState.kind === "zapped") return "1/2 done · preparing approve…";
      if (flowState.kind === "approving") return "Approving SY for Router…";
      if (flowState.kind === "approved") return "2/2 · preparing Buy PT…";
      if (flowState.kind === "buying") return "2/2 · Buying PT…";
      if (flowState.kind === "done") return "✓ Done";
      return `Buy PT via Zap`;
    }
    // SY mode
    if (parsedSy === 0n) return "Enter amount";
    if (insufficient) return "Insufficient SY";
    if (sizeLimit.exceeded) return "Trade too large for pool";
    if (flowState.kind === "error") {
      return flowState.failedAt === 1 ? "Retry association" : flowState.failedAt === 3 ? "Retry approval" : "Retry buy";
    }
    if (flowState.kind === "associating") return "Associating PT…";
    if (flowState.kind === "approving") return "Approving SY for Router…";
    if (flowState.kind === "buying") return "Buying PT…";
    if (flowState.kind === "done") return "✓ Done";
    if (isPending) return "Sign in HashPack…";
    if (isConfirmingFinal) return "Waiting for confirmation…";
    if (needsApprove) return "Approve SY for Router";
    return "Buy PT";
  };

  // HBAR floor = v3NpmFeeBudget (5 HBAR on-chain) + 1 HBAR buffer for actual
  // SY mint. Sub-floor inputs hit AmountZero on-chain — block in UI.
  const hbarBelowFloor = effectiveSource === "hbar" && hbarAmount > 0 && hbarAmount < 6;
  const buttonDisabled =
    // Once the flow has settled, the primary button is a non-interactive
    // "✓ Done" indicator — clicking it must NOT re-fire the trade. Reset is via
    // the "New trade" link below.
    isDoneFinal ||
    !user ||
    isPending ||
    isConfirmingFinal ||
    !routerDeployed ||
    (effectiveSource === "hbar"
      ? hbarAmount === 0 || !zapAvailable || hbarBelowFloor || hbarExceedsContractCap
      : parsedSy === 0n || insufficient || sizeLimit.exceeded);

  return (
    <div className="flex flex-col gap-3">
      <FlowOfFunds title="Flow of funds · Buy PT" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Buy PT"
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
              {maxPtUsd !== undefined && (
                <StatusPill tone="info">Max ~${maxPtUsd.toFixed(2)}</StatusPill>
              )}
            </>
          }
        />

        {/* Pendle-style: SY is an intermediate, never an end goal. Users only
            see HBAR-in → PT-out. The SY-source path exists in the code as a
            fallback when the zap isn't deployed for this market — surfaced
            with a thin notice rather than a toggle. */}
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
            ptEstimate={ptEstimate}
            minPtOut={minPtOut}
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
                {maxPtUsd !== undefined ? ` (max PT now ≈ $${maxPtUsd.toFixed(2)})` : ""}
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
        )}

        {user && needsSy && effectiveSource === "sy" && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-warning">
            <span className="font-semibold">You have 0 SY shares.</span> Switch the
            source to <span className="font-semibold">HBAR</span> above to mint SY +
            buy PT in one flow.
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
              ? "One HashPack popup (plus a one-time token-associate if you've never touched SY/PT)."
              : "Up to 4 HashPack popups: associate tokens, zap to SY, approve, buy PT."}
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
            <div className="font-semibold uppercase tracking-[1px]">PT acquired.</div>
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

/* ─────────────────────────────────────────────────────── HBAR-mode input */

/**
 * HBAR-mode input — USD/HBAR toggle, with a 3-stage preview:
 *
 *   You pay        [USD] [HBAR]
 *   $ 5.00
 *   ≈ 52.84 HBAR → ~52.8M SY → ~53.8M PT
 *   Min received 53.5M PT · Slippage ≤ 0.50%
 *
 * Mirrors the MoneyInput styling so the form layout stays identical between
 * source modes. Doesn't enforce an "insufficient HBAR" check — wallet rejects
 * are clearer + reading HBAR balance is a separate call we'd rather not add
 * to every form render.
 */
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
  ptEstimate,
  minPtOut,
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
  ptEstimate: bigint;
  minPtOut: bigint;
  slippageBps: number;
}) {
  // Force raw (HBAR) mode if no price feed.
  const effective = hbarUsd === undefined ? "raw" : inputMode;
  // Periphery reserves 5 HBAR (v3NpmFeeBudget) for the V3 NPM mint fee.
  // Any HBAR ≤ 5 produces effective-zap = 0 → AmountZero revert. Block ≤ 6
  // HBAR in the UI so the user sees a clear floor instead of a cryptic
  // on-chain revert.
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
          <span className="flex items-center pl-3 font-mono text-base text-textDim">
            $
          </span>
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
          <span className="flex items-center pr-3 font-mono text-[12px] text-textDim">
            HBAR
          </span>
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

      {/* Three-stage preview line: HBAR → SY → PT */}
      {hbarAmount > 0 && estimatedSy > 0n && (
        <div className="mt-1 font-mono text-[10px] text-textSec">
          <span>
            {hbarAmount.toFixed(2)} HBAR
          </span>
          <span className="text-textDim"> → </span>
          <span className="text-text">~{formatCompact(estimatedSy)} SY</span>
          {ptEstimate > 0n && (
            <>
              <span className="text-textDim"> → </span>
              <span className="text-text">~{formatCompact(ptEstimate)} PT</span>
            </>
          )}
        </div>
      )}
      {ptEstimate > 0n && (
        <div className="mt-0.5 font-mono text-[10px] text-textDim">
          Min received <span className="text-text">{formatCompact(minPtOut)} PT</span> ·{" "}
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

// Read-only viem client for trade-time Lens inversion (sizing ptOut needs
// dynamic iterations, which wagmi's declarative hooks can't do).
let _lensClient: ReturnType<typeof createPublicClient> | null = null;
function lensClient() {
  if (!_lensClient) {
    _lensClient = createPublicClient({ chain: hederaMainnet, transport: hederaReadTransport() });
  }
  return _lensClient;
}

/**
 * BUY-PT-01 / BUYPT-LENS-RPC-STORM fix — pick the EXACT ptOut to mint by
 * inverting the Lens with a SEEDED closed-form estimate (<=6 Lens reads),
 * not the old 40-iteration doubling-bracket + binary search (measured 60-67
 * serial eth_calls, ~60-100s per Buy-PT click, and a single Hashio 429
 * mid-burst returned 0n → a false "quoter unreachable" hard-abort for a funded
 * user).
 *
 * The periphery's `buySyForPt(market, syIn, minPtOut=ptOut, …)` treats arg3 as
 * the exact PT to mint and caps the SY it may spend at `syIn`. The market
 * reverts (InsufficientOutput) when the curve needs > syIn SY for that ptOut.
 * `lens.previewSwapExactSyForPt(market, ptOut)` returns exactly that required
 * SY (same MarketMath.executeTradeCore path the swap uses).
 *
 * Strategy:
 *   budgetAdj = syIn · (10000 - slippageBps)/10000.
 *   1 rate probe → rate = cost/ptOut (~0.98-0.99e18 SY-per-PT). The curve is
 *   convex, so a rate read at/under the final size slightly UNDER-estimates the
 *   true average rate → the closed-form seed (budgetAdj/rate) slightly
 *   OVERSHOOTS → the linear correction (ptOut·budgetAdj/cost) pulls it down,
 *   converging from above. The Lens reverts above the pool cap, so the probe
 *   shrinks geometrically until it succeeds.
 *
 * GUARANTEE: returns only a ptOut whose preview cost we CONFIRMED <= budgetAdj
 * (so the on-chain buySyForPt never reverts InsufficientOutput). A throttled /
 * late read can never promote an unverified (possibly over-budget) ptOut into
 * the tx. If we never confirm one (every read throttles / the lens is down),
 * returns 0n → caller's existing "quoter unreachable" abort fires instead of
 * submitting a guaranteed-revert ptOut.
 *
 * Hard ceiling: <=6 serial Lens reads, plus an ~8s wall-clock cutoff.
 */
async function computePtOutForBudget(
  market: `0x${string}`,
  syIn: bigint,
  slippageBps: number,
): Promise<bigint> {
  if (syIn <= 0n) return 0n;
  const budgetAdj = (syIn * BigInt(10_000 - slippageBps)) / 10_000n;
  if (budgetAdj <= 0n) return 0n;
  const client = lensClient();

  const MAX_CALLS = 6; // hard ceiling on serial Lens reads (was 60+).
  const WALL_MS = 14000; // wall-clock cutoff (bumped for RPC retries + mirror fallback).
  const start = Date.now();
  let calls = 0;
  const budgetLeft = () => calls < MAX_CALLS && Date.now() - start < WALL_MS;

  // Largest ptOut we have CONFIRMED on-chain to cost <= budgetAdj. Every return
  // path uses this — never an unconfirmed estimate.
  let bestSafe = 0n;
  const probe = async (ptOut: bigint): Promise<bigint | null> => {
    calls++;
    let cost: bigint;
    try {
      cost = (await client.readContract({
        abi: lensAbi,
        address: ADDRESSES.lens,
        functionName: "previewSwapExactSyForPt",
        args: [market, ptOut],
      })) as bigint;
    } catch {
      // Hashio threw — either the call reverted (past pool cap) OR the public
      // relay throttled us (429 under a user spike). Fall back to the MIRROR
      // NODE's contracts/call (separate infra, keyless, not relay-rate-limited);
      // a genuine revert fails there too → null. This keeps the Buy-PT quoter
      // alive through a Hashio throttle storm instead of hard-aborting Step 4.
      try {
        const hex = await mirrorContractRead(
          ADDRESSES.lens,
          encodeFunctionData({
            abi: lensAbi,
            functionName: "previewSwapExactSyForPt",
            args: [market, ptOut],
          }),
        );
        if (!hex) return null;
        cost = decodeFunctionResult({
          abi: lensAbi,
          functionName: "previewSwapExactSyForPt",
          data: hex,
        }) as bigint;
      } catch {
        return null;
      }
    }
    if (cost > 0n && cost <= budgetAdj && ptOut > bestSafe) bestSafe = ptOut;
    return cost;
  };

  // 1) Rate probe. Start at budgetAdj; shrink geometrically past the pool cap.
  let probePt = budgetAdj > 1n ? budgetAdj : 1n;
  let probeCost: bigint | null = null;
  for (let i = 0; i < 5 && budgetLeft(); i++) {
    probeCost = await probe(probePt);
    if (probeCost !== null && probeCost > 0n) break;
    probePt = probePt / 4n;
    if (probePt < 1n) {
      probePt = 1n;
      break;
    }
  }
  // Even the probe is unreachable / zero → caller's "quoter unreachable" abort.
  if (probeCost === null || probeCost === 0n) return 0n;

  // 2) Closed-form seed.
  const rate = (probeCost * 10n ** 18n) / probePt; // SY-per-PT, e18
  let ptOut = (budgetAdj * 10n ** 18n) / rate;
  if (ptOut <= 0n) ptOut = 1n;

  // 3) Up to 3 linear-correction iterations.
  for (let i = 0; i < 3 && budgetLeft(); i++) {
    const cost = await probe(ptOut);
    if (cost === null) {
      // Overshot past the cap (or a throttle) → halve and retry within the cap.
      ptOut = ptOut / 2n;
      if (ptOut < 1n) ptOut = 1n;
      continue;
    }
    if (cost <= budgetAdj) {
      // Within 0.05% of budget → good enough.
      if (cost >= (budgetAdj * 9995n) / 10_000n) break;
      const scaled = (ptOut * budgetAdj) / cost; // >= ptOut (under budget)
      if (scaled <= ptOut) break; // no progress
      ptOut = scaled;
    } else {
      ptOut = (ptOut * budgetAdj) / cost; // < ptOut (over budget)
      if (ptOut < 1n) ptOut = 1n;
    }
  }

  // 4) Final guarantee: confirm the chosen ptOut <= budgetAdj. If it (or a
  //    throttled read) doesn't confirm, step down a few bps until one does.
  if (ptOut !== bestSafe) {
    let chosen = ptOut;
    for (let i = 0; i < 6 && budgetLeft(); i++) {
      const c = await probe(chosen); // updates bestSafe on success
      if (c !== null && c <= budgetAdj) break;
      chosen = (chosen * 9990n) / 10_000n; // -0.1% per step
      if (chosen < 1n) break;
    }
  }

  // Return only a confirmed-safe ptOut (0n → caller aborts cleanly).
  return bestSafe;
}

/**
 * F6 fix — normalize a Hedera consensus tx-id (`0.0.X@S.NS`) into the
 * dash form HashScan's URL accepts (`0.0.X-S-NS`). The account keeps its
 * dots; only the timestamp's seconds.nanos dot becomes a dash. EVM hashes
 * (`0x…`) and already-normalized ids pass through unchanged.
 */
function hashscanTxId(raw: string): string {
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  const acct = raw.slice(0, at);
  const ts = raw.slice(at + 1);
  return `${acct}-${ts.replace(".", "-")}`;
}

/**
 * F10 helper — resolve a `0.0.X` Hedera account id from an EVM address via the
 * mirror node, so the EVM/injected path can run the same association precheck
 * the Hedera path does. Returns null if the mirror can't map it (the buy then
 * proceeds and relies on HIP-904 / on-chain delivery, i.e. unchanged behavior).
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
