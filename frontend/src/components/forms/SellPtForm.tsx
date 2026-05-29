"use client";

/**
 * SellPtForm — exit a PT position pre-expiry by selling into the AMM. PT in,
 * SY back out. Uses `router.swapExactPtForSy` (contract has supported this
 * since v1; UI was missing until now).
 *
 * Same shell as BuyPtForm but unidirectional (PT only, no HBAR zap):
 *   1. setOperator(periphery, true)  (one-time, if not already operator)
 *   2. Approve SY-share → Periphery  (one-time, for the Tx2 unzap)
 *   3. Tx1: sellPtForSy (PT → SY shares)  — NO PT approve: PT is freeze-by-
 *      default and the sell WIPES it; there is no allowance path to consume.
 *   4. Tx2: unzapSyToHbar (SY shares → HBAR)
 *
 * Post-expiry, prefer `redeemAfterExpiry` (1:1) over swap — the AMM curve
 * pays slightly less than par. The form auto-disables in that case.
 */
import { useCallback, useMemo, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ptToSyRate } from "@/components/MarketPositionCard";
import { useSyValueUsd } from "@/hooks/useSyValueUsd";
import { ADDRESSES, isDeployed, MAX_HTS_APPROVE } from "@/lib/addresses";
import { lensAbi } from "@/lib/abis";
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
}

type FlowKind =
  | { kind: "idle" }
  | { kind: "granting" } // tx0: market.setOperator(periphery, true) — one-time
  | { kind: "approvingSy" } // approve SY-share → Periphery (for tx2 unzap)
  | { kind: "selling" } // tx1: PT → SY (no PT approve — the sell WIPES PT)
  | { kind: "unzapping" } // tx2: SY → HBAR
  | { kind: "done"; finalTxHash: string }
  | {
      kind: "error";
      message: string;
      failedAt: "grant" | "approveSy" | "sell" | "unzap";
      // SELL-RESUME-UNZAP-01: when the failure is at the unzap leg, Tx1 already
      // delivered SY-share to the user. We persist the EXACT delta the sell
      // produced so an unzap-resume converts only that delta — not the user's
      // full SY-share balance (which would sweep unrelated SY holdings to HBAR).
      sellDelta?: bigint;
    };

export function SellPtForm({ market, detail, user }: Props) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const { usdPerShare } = useSyValueUsd(detail.sy);
  // SELL-MINHBAR-COINGECKO-01: pool-sourced HBAR/USD (USDC/WHBAR slot0) — the
  // SAME rate the unzap's inner swap executes at. Used to floor minHbarOut so
  // the floor is consistent with execution (never CoinGecko, which can diverge).
  // SellPt displays PT/SY USD (usdPerShare), so no CoinGecko HBAR/USD is needed.
  const poolHbarUsd = usePoolHbarUsd();

  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [rawStr, setRawStr] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);

  const [flowState, setFlowState] = useState<FlowKind>({ kind: "idle" });
  const [lastTxHash, setLastTxHash] = useState<string | undefined>(undefined);
  const [writeError, setWriteError] = useState<string | null>(null);

  const useWagmiReceipt = adapter.mode === "evm";
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: useWagmiReceipt ? (lastTxHash as `0x${string}` | undefined) : undefined,
    query: { enabled: useWagmiReceipt && !!lastTxHash && lastTxHash.startsWith("0x") },
  });
  const isConfirmingFinal = useWagmiReceipt ? isConfirming : false;

  // Post-rebuild (2026-05-27): 2-tx flow via FissionPeriphery.
  // Tx1: Periphery.sellPtForSy (PT → SY shares, delivered to user)
  // Tx2: Periphery.unzapSyToHbar (SY shares → HBAR, sent to user)
  // User must also approve SY-share → Periphery once before Tx2 succeeds.
  const peripheryDeployed = isDeployed(ADDRESSES.periphery);
  const expired = Date.now() / 1000 >= Number(detail.expiry);

  /* ─────────────────────────── PT balance + allowance reads */

  const spender: `0x${string}` = ADDRESSES.periphery;
  const erc20AllowanceAbi = [
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
  ] as const;
  const erc20BalanceAbi = [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }],
      outputs: [{ type: "uint256" }],
    },
  ] as const;
  // SELL-02: NO PT-approve prerequisite. PT is freeze-by-default and the sell
  // WIPES the user's PT (the market holds PT's WIPE key) — there is no
  // allowance/transferFrom path the sell ever consumes. An HTS approve from a
  // frozen account reverts ACCOUNT_FROZEN_FOR_TOKEN, dead-locking the flow
  // before the swap. So we don't read PT allowance and we never call approve on
  // PT (mirrors SellYtForm, which correctly has no token approve). The only
  // sell prerequisites are: setOperator(periphery, true) [if not already
  // operator] and the SY-share → Periphery approve for the Tx2 unzap.
  const ptRead = useReadContracts({
    contracts: user
      ? [
          { abi: erc20BalanceAbi, address: detail.pt, functionName: "balanceOf", args: [user] } as const,
          // W2-04: operator grant on the market — the sell routes through the
          // operator-gated swapExactPtForSyFor; without it the Periphery reverts.
          {
            abi: [
              {
                type: "function",
                name: "isOperator",
                stateMutability: "view",
                inputs: [
                  { name: "owner", type: "address" },
                  { name: "operator", type: "address" },
                ],
                outputs: [{ type: "bool" }],
              },
            ] as const,
            address: market,
            functionName: "isOperator",
            args: [user, spender],
          } as const,
          // W2-05: SY-share allowance to the Periphery — Tx2 (unzapSyToHbar)
          // pulls the SY-share token via transferFrom; without this it reverts.
          { abi: erc20AllowanceAbi, address: detail.syShare, functionName: "allowance", args: [user, spender] } as const,
          // SY-share balance — used to compute the post-Tx1 delta to unzap.
          { abi: erc20BalanceAbi, address: detail.syShare, functionName: "balanceOf", args: [user] } as const,
        ]
      : [],
    query: { enabled: !!user },
    allowFailure: true,
  });
  const ptBalance =
    ptRead.data?.[0]?.status === "success" ? (ptRead.data[0].result as bigint) : 0n;
  const isOperator =
    ptRead.data?.[1]?.status === "success" ? (ptRead.data[1].result as boolean) : false;
  const syShareAllowance =
    ptRead.data?.[2]?.status === "success" ? (ptRead.data[2].result as bigint) : 0n;
  const onChainSyShare =
    ptRead.data?.[3]?.status === "success" ? (ptRead.data[3].result as bigint) : 0n;
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

  // W2-07: use lens.previewSwapExactPtForSy(market, ptIn) for the exact AMM
  // output, falling back to the linear approximation only if the lens isn't
  // deployed in this env. The linear model drifts; the lens matches the curve.
  const lensReady = isDeployed(ADDRESSES.lens) && parsedPt > 0n;
  const lensRead = useReadContracts({
    contracts: lensReady
      ? [
          {
            abi: lensAbi,
            address: ADDRESSES.lens,
            functionName: "previewSwapExactPtForSy",
            args: [market, parsedPt],
          } as const,
        ]
      : [],
    query: { enabled: lensReady },
    allowFailure: true,
  });
  const lensSyOut =
    lensRead.data?.[0]?.status === "success"
      ? (lensRead.data[0].result as bigint)
      : undefined;
  const linearEstimate =
    parsedPt > 0n && ptRate > 0 ? BigInt(Math.floor(Number(parsedPt) * ptRate)) : 0n;
  const syEstimate = lensSyOut ?? linearEstimate;
  // W2-07: minSyOut from the preview × (1 − slippage), no longer a decorative 1n.
  const minSyOut = (syEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

  // F3/F4: the Tx2 unzap (SY → HBAR) needs a trustworthy price to set
  // minHbarOut. A 1n floor is NOT acceptable here — the inner USDC→WHBAR leg
  // uses amountOutMinimum:0, so a 1n outer floor is sandwich-exploitable.
  //
  // SELL-MINHBAR-COINGECKO-01: the minHbarOut floor is sourced from `poolHbarUsd`
  // (the SaucerSwap V2 USDC/WHBAR slot0 — the rate the unzap actually swaps at),
  // NOT CoinGecko's `hbarUsd`. So we gate the sell on the FLOOR sources being
  // present: `usdPerShare` (SY-share USD) + `poolHbarUsd` (the pool rate). Both
  // are CoinGecko-independent on-chain reads, so a blocked/429ing CoinGecko no
  // longer trips this — we only hard-block when the on-chain pool read itself
  // fails. Blocking here prevents wiping the PT position at Tx1 and then being
  // unable to price the Tx2 floor. Only matters once there's an amount to sell.
  const priceFeedUnavailable =
    parsedPt > 0n && (usdPerShare === undefined || poolHbarUsd === undefined);

  // SELL-02: no PT-approve. Prerequisites are the operator grant + the
  // SY-share approve for the Tx2 unzap.
  const needsGrant = parsedPt > 0n && !isOperator;
  const needsSyApprove = parsedPt > 0n && syShareAllowance < syEstimate;

  /* ─────────────────────────── flow runners */

  // Snapshot the user's SY-share balance before Tx1 so Tx2 can unzap exactly
  // the delta the sell delivered (rather than an estimate or a stale figure).
  const readSyShareBalance = useCallback(async (): Promise<bigint> => {
    try {
      const r = await ptRead.refetch();
      if (r.data?.[3]?.status === "success") return r.data[3].result as bigint;
    } catch {
      /* fall through */
    }
    return onChainSyShare;
  }, [ptRead, onChainSyShare]);

  // Poll the SY-share balance after Tx1 (Hashio mirror lags 1-2s) and return
  // the realized delta (post - pre); falls back to the lens estimate.
  const readPostSellSyDelta = useCallback(
    async (preSell: bigint, fallback: bigint): Promise<bigint> => {
      for (let i = 0; i < 5; i++) {
        try {
          const r = await ptRead.refetch();
          const fresh = r.data?.[3]?.status === "success" ? (r.data[3].result as bigint) : preSell;
          if (fresh > preSell) return fresh - preSell;
        } catch {
          /* retry */
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      return fallback;
    },
    [ptRead],
  );

  // SELL-NO-SYSHARE-ASSOC / REALUSE-01: Tx1 (sellPtForSy) ends by delivering
  // SY-share to the user via safeTransfer. On a HIP-904 limited-association
  // wallet (max_auto=0) that has never held SY-share, that transfer reverts
  // TOKEN_NOT_ASSOCIATED (184) at consensus — invisible to eth_call, so it
  // surfaces only as a failed tx that ALREADY wiped the PT. The Buy PT flow
  // pre-associates [syShare,…]; the sell path did not. The unzap delivers
  // native HBAR (no association needed), so SY-share is the only delivered
  // token to precheck. We precheck in BOTH modes:
  //   • Hedera mode: auto-associate the missing token(s) (one prompt).
  //   • EVM mode: MetaMask CANNOT submit a Hedera TokenAssociate tx, so we
  //     resolve the EVM address → 0.0.id via mirror, check associations, and
  //     BLOCK the sell with an actionable message rather than let Tx1 wipe the
  //     PT and Tx1's delivery revert at consensus.
  // No-op for HIP-904-unlimited wallets (getMissingAssociations short-circuits
  // on max_auto === -1) and if the account can't be resolved (let the chain be
  // authoritative rather than false-block).
  const runAssociateSyShare = useCallback(async (): Promise<boolean> => {
    try {
      const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
        await import("@/lib/hedera-wallet/associations");
      const ids = [detail.syShare].map(evmAddressToTokenId);

      if (adapter.mode === "hedera" && adapter.accountId) {
        const missing = await getMissingAssociations(adapter.accountId, ids);
        if (missing.length > 0) {
          await associateTokens(hedera.getConnector(), adapter.accountId, missing);
          await ptRead.refetch();
        }
        return true;
      }

      if (adapter.mode === "evm" && adapter.address) {
        // Resolve the EVM address to its Hedera id so we can check on the mirror.
        const accountId = await evmAddressToAccountId(adapter.address);
        if (!accountId) return true; // unresolved → let the chain be authoritative
        const missing = await getMissingAssociations(accountId, ids);
        if (missing.length > 0) {
          const msg =
            `Your account hasn't associated the SY-share token (${missing.join(", ")}). ` +
            "MetaMask can't submit a Hedera token-association, so this sell can't " +
            "deliver to you. Enable automatic token associations in your wallet, or " +
            "associate the token first (e.g. in HashPack), then retry.";
          setWriteError(msg);
          setFlowState({ kind: "error", message: msg, failedAt: "sell" });
          return false;
        }
        return true;
      }

      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg, failedAt: "sell" });
      return false;
    }
  }, [adapter.mode, adapter.accountId, adapter.address, detail.syShare, hedera, ptRead]);

  // W2-04: one-time operator grant on the market. The Periphery's sellPtForSy
  // calls market.swapExactPtForSyFor(user, …) and reverts (NotAuthorized) until
  // the user has set the Periphery as operator. Reuses the existing
  // marketSetOperator op with approved:true.
  const runGrant = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    setFlowState({ kind: "granting" });
    try {
      const { txHash } = await adapter.write({
        kind: "marketSetOperator",
        market,
        operator: spender,
        approved: true,
      });
      setLastTxHash(txHash);
      await new Promise((r) => setTimeout(r, adapter.mode === "evm" ? 3500 : 1500));
      await ptRead.refetch();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg, failedAt: "grant" });
      return false;
    }
  }, [adapter, market, ptRead, spender, user]);

  // W2-05: approve SY-share → Periphery so Tx2 (unzapSyToHbar) can transferFrom.
  const runApproveSy = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    setFlowState({ kind: "approvingSy" });
    try {
      const { txHash } = await adapter.write({
        kind: "approveErc20",
        token: detail.syShare,
        spender,
        amount: MAX_HTS_APPROVE,
      });
      setLastTxHash(txHash);
      await new Promise((r) => setTimeout(r, adapter.mode === "evm" ? 3500 : 1500));
      await ptRead.refetch();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg, failedAt: "approveSy" });
      return false;
    }
  }, [adapter, detail.syShare, ptRead, spender, user]);

  const runSell = useCallback(async (): Promise<bigint | null> => {
    // Tx 1: PT → SY via Periphery.sellPtForSy. Returns the SY-share amount the
    // sell actually delivered to the user (chain-observed delta).
    if (!user) return null;
    const preSell = await readSyShareBalance();
    setFlowState({ kind: "selling" });
    try {
      const { txHash } = await adapter.write({
        kind: "writePeriphery",
        functionName: "sellPtForSy",
        // W2-07: minSyOut from the lens preview, not 1n.
        args: [market, parsedPt, minSyOut, user, 0n],
      });
      setLastTxHash(txHash);
      // Wait briefly for receipt, then read the realized SY-share delta.
      await new Promise((r) => setTimeout(r, adapter.mode === "evm" ? 3500 : 1500));
      const delta = await readPostSellSyDelta(preSell, syEstimate);
      return delta;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg, failedAt: "sell" });
      return null;
    }
  }, [adapter, market, parsedPt, user, minSyOut, syEstimate, readSyShareBalance, readPostSellSyDelta]);

  const runUnzap = useCallback(async (sySharesToUnzap: bigint): Promise<boolean> => {
    // Tx 2: SY → HBAR via Periphery.unzapSyToHbar.
    // User must have approved SY-share → Periphery (one-time setup, runApproveSy).
    if (!user || sySharesToUnzap === 0n) return false;

    // F3 + F4 + SELL-03 + SELL-MINHBAR-COINGECKO-01: derive minHbarOut from the
    // REALIZED SY-share delta (not the pre-trade estimate) using the POOL-sourced
    // HBAR/USD — the SAME rate the unzap's inner USDC→WHBAR swap executes at
    // (amountOutMinimum:0). Pricing the floor off CoinGecko (`hbarUsd`) would let
    // a CoinGecko-underprices-pool divergence revert this Tx AFTER Tx1 wiped the
    // position; pricing it off `poolHbarUsd` keeps the floor consistent with
    // execution. We BLOCK (never ship a 1n floor) when the floor source is down.
    if (usdPerShare === undefined || poolHbarUsd === undefined) {
      const msg =
        "Price feed unavailable — can't safely set a minimum HBAR floor for the SY→HBAR conversion. Your PT is now SY in your wallet; try the conversion again once pricing is back.";
      setWriteError(msg);
      // SELL-RESUME-UNZAP-01: persist the exact delta so a resume unzaps only it.
      setFlowState({ kind: "error", message: msg, failedAt: "unzap", sellDelta: sySharesToUnzap });
      return false;
    }
    setFlowState({ kind: "unzapping" });
    // HBAR expected from THIS realized SY delta = shares × usdPerShare / poolHbarUsd,
    // floored by the slippage chip. Pool-sourced rate = execution-consistent. Never 1n.
    const hbarForDelta = (Number(sySharesToUnzap) * usdPerShare) / Math.max(1e-9, poolHbarUsd);
    const minHbarOut =
      (BigInt(Math.floor(hbarForDelta * 1e8)) * BigInt(10_000 - slippageBps)) / 10_000n;
    if (minHbarOut <= 0n) {
      const msg =
        "Computed HBAR floor rounded to zero — refusing to send an unprotected unzap. Try a larger amount or check the price feed.";
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg, failedAt: "unzap", sellDelta: sySharesToUnzap });
      return false;
    }
    try {
      const { txHash } = await adapter.write({
        kind: "writePeriphery",
        functionName: "unzapSyToHbar",
        args: [detail.sy, sySharesToUnzap, minHbarOut, 0n],
      });
      setLastTxHash(txHash);
      setFlowState({ kind: "done", finalTxHash: txHash });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      // SELL-RESUME-UNZAP-01: persist the exact delta so a resume unzaps only it.
      setFlowState({ kind: "error", message: msg, failedAt: "unzap", sellDelta: sySharesToUnzap });
      return false;
    }
  }, [adapter, detail.sy, user, usdPerShare, poolHbarUsd, slippageBps]);

  // Run the remaining steps after the operator grant + PT approve are settled.
  const runSellAndUnzap = useCallback(async (): Promise<void> => {
    if (needsSyApprove) {
      const ok = await runApproveSy();
      if (!ok) return;
    }
    const syOut = await runSell();
    if (syOut === null) return;
    await runUnzap(syOut);
  }, [needsSyApprove, runApproveSy, runSell, runUnzap]);

  const onPrimary = useCallback(async () => {
    if (!user || parsedPt === 0n || !peripheryDeployed || expired) return;
    if (insufficient || sizeLimit.exceeded) return;
    setWriteError(null);

    if (flowState.kind === "error") {
      // Resume from the failed step, walking the rest of the chain.
      if (flowState.failedAt === "grant") {
        // SELL-NO-SYSHARE-ASSOC: a "grant"/"sell"-tagged failure may actually be
        // a missing SY-share association — re-run the (idempotent) precheck.
        if (!(await runAssociateSyShare())) return;
        const ok = await runGrant();
        if (!ok) return;
        await runSellAndUnzap();
      } else if (flowState.failedAt === "approveSy") {
        const ok = await runApproveSy();
        if (!ok) return;
        const syOut = await runSell();
        if (syOut === null) return;
        await runUnzap(syOut);
      } else if (flowState.failedAt === "sell") {
        // SELL-NO-SYSHARE-ASSOC: re-run the idempotent association precheck — a
        // sell-tagged failure is most often a missing SY-share association.
        if (!(await runAssociateSyShare())) return;
        const syOut = await runSell();
        if (syOut === null) return;
        await runUnzap(syOut);
      } else {
        // SELL-RESUME-UNZAP-01: failed at unzap — Tx1 already delivered SY to
        // the user. Unzap ONLY the persisted sell delta (NOT the full balanceOf,
        // which would sweep the user's unrelated SY holdings to HBAR). If the
        // delta wasn't persisted (older error state), fall back to the full
        // balance but require an explicit confirm so we never silently convert
        // an unrelated SY position the user didn't intend to exit.
        const persistedDelta = flowState.sellDelta;
        if (persistedDelta !== undefined && persistedDelta > 0n) {
          await runUnzap(persistedDelta);
        } else {
          const bal = await readSyShareBalance();
          const toUnzap = bal > 0n ? bal : syEstimate;
          const ok =
            typeof window === "undefined" ||
            window.confirm(
              `Couldn't determine exactly how much SY this sell produced. Continuing will convert your ENTIRE SY-share balance (${formatCompact(toUnzap)}) to HBAR — including any unrelated SY you hold. Proceed?`,
            );
          if (!ok) return;
          await runUnzap(toUnzap);
        }
      }
      return;
    }

    // SELL-NO-SYSHARE-ASSOC / REALUSE-01: precheck SY-share association before
    // anything else (Tx1 delivers it; a limited-association wallet would
    // otherwise revert at consensus AFTER wiping the PT). Hedera mode auto-
    // associates; EVM mode blocks on missing (MetaMask can't associate).
    // No-op for HIP-904-unlimited wallets / unresolved accounts.
    if (!(await runAssociateSyShare())) return;

    // W2-04: grant operator first if the market doesn't yet authorize the
    // Periphery (one-time per wallet). SELL-02: there is NO PT approve — the
    // sell wipes PT directly, so the only token approve is SY-share (handled
    // inside runSellAndUnzap for the Tx2 unzap).
    if (needsGrant) {
      const ok = await runGrant();
      if (!ok) return;
    }
    await runSellAndUnzap();
  }, [user, parsedPt, peripheryDeployed, expired, insufficient, sizeLimit.exceeded, flowState, needsGrant, runAssociateSyShare, runGrant, runApproveSy, runSell, runUnzap, runSellAndUnzap, readSyShareBalance, syEstimate]);

  const isPending =
    adapter.isWritePending ||
    flowState.kind === "granting" ||
    flowState.kind === "approvingSy" ||
    flowState.kind === "selling" ||
    flowState.kind === "unzapping";

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
      label: "Periphery",
      detail: shortAddr(ADDRESSES.periphery),
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
    if (priceFeedUnavailable) return "Price feed unavailable — try again";
    if (flowState.kind === "error") {
      switch (flowState.failedAt) {
        case "grant": return "Retry enable selling";
        case "approveSy": return "Retry SY approval";
        case "unzap": return "Retry convert to HBAR";
        default: return "Retry sell";
      }
    }
    if (flowState.kind === "granting") return "Enabling selling…";
    if (flowState.kind === "approvingSy") return "Approving SY for Periphery…";
    if (flowState.kind === "selling") return "Step 1/2 · Selling PT → SY…";
    if (flowState.kind === "unzapping") return "Step 2/2 · Converting SY → HBAR…";
    if (flowState.kind === "done") return "✓ Done";
    if (isConfirmingFinal) return "Waiting for confirmation…";
    if (needsGrant) return "Enable selling + Sell PT for HBAR";
    return "Sell PT for HBAR";
  };

  const buttonDisabled =
    !user ||
    isPending ||
    isConfirmingFinal ||
    !peripheryDeployed ||
    expired ||
    parsedPt === 0n ||
    insufficient ||
    sizeLimit.exceeded ||
    // F3: block the sell while we can't price the SY→HBAR leg.
    priceFeedUnavailable;

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
                {flowState.failedAt === "grant"
                  ? "Enable selling failed"
                  : flowState.failedAt === "approveSy"
                    ? "Approval failed"
                    : flowState.failedAt === "unzap"
                      ? "Convert to HBAR failed"
                      : "Swap failed"}
              </div>
            )}
            {writeError.slice(0, 240)}
          </div>
        )}

        {flowState.kind === "done" && lastTxHash && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-success">
            <div className="font-semibold uppercase tracking-[1px]">PT sold for HBAR.</div>
            <div className="mt-1 break-all text-[10px] text-success/80">
              tx: {lastTxHash.slice(0, 18)}…{lastTxHash.slice(-8)}
            </div>
            <div className="mt-1.5 flex gap-3">
              <a
                href={hashscanTxUrl(lastTxHash)}
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

        {!peripheryDeployed && (
          <p className="mt-2 font-mono text-[11px] text-error">Periphery not deployed yet.</p>
        )}
      </div>
    </div>
  );
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/* ───────────────────────────── EVM → Hedera account-id resolver ───────────
 * REALUSE-01: in EVM (MetaMask) mode the adapter exposes only the 0x EVM
 * address — there is no `0.0.X` accountId. To check HTS associations on the
 * mirror node we resolve the EVM address to its canonical Hedera id via
 * `GET /accounts/{evmAddress}` (works for both ECDSA-aliased and long-zero
 * accounts). Returns undefined if the account isn't found / mirror is down. */
const MIRROR_BASE_FORM = "https://mainnet-public.mirrornode.hedera.com/api/v1";
async function evmAddressToAccountId(
  evmAddress: `0x${string}`,
): Promise<string | undefined> {
  try {
    const r = await fetch(`${MIRROR_BASE_FORM}/accounts/${evmAddress}`);
    if (!r.ok) return undefined;
    const data = (await r.json()) as { account?: string };
    return typeof data.account === "string" ? data.account : undefined;
  } catch {
    return undefined;
  }
}

/* ───────────────────────────── pool-derived HBAR/USD floor source ─────────
 * SELL-MINHBAR-COINGECKO-01: the unzap's inner USDC→WHBAR swap executes at the
 * SaucerSwap V2 POOL price (amountOutMinimum:0). Pricing minHbarOut off
 * CoinGecko's hbarUsd lets a CoinGecko-underprices-pool divergence revert Tx2
 * AFTER Tx1 already wiped the position. So the floor must come from the SAME
 * source the swap uses: the pool's slot0. This local hook reads the USDC/WHBAR
 * V2 pool slot0 directly — identical math/constants to useSyValueUsd's on-chain
 * fallback — so the floor is consistent with execution regardless of whether
 * CoinGecko is up. (A parallel agent exposes the same value as `poolHbarUsd` on
 * the price hook; this self-contained copy is equivalent and avoids coupling.)
 */
const POOL_FLOOR_FACTORY = "0x00000000000000000000000000000000003c3951" as const;
const POOL_FLOOR_USDC = "0x000000000000000000000000000000000006f89a" as const;
const POOL_FLOOR_WHBAR = "0x0000000000000000000000000000000000163b5a" as const;
const POOL_FLOOR_FEE = 1500; // 0.15% USDC/WHBAR V2 tier (verified live).
const POOL_FLOOR_Q96 = 2n ** 96n;

const poolFloorFactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;
const poolFloorSlot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

function poolHbarUsdFromSqrtP(sqrtPriceX96: bigint): number | undefined {
  if (sqrtPriceX96 <= 0n) return undefined;
  const sp = Number(sqrtPriceX96) / Number(POOL_FLOOR_Q96);
  if (!Number.isFinite(sp) || sp <= 0) return undefined;
  const rawPrice = sp * sp; // WHBAR_raw per USDC_raw (token0=USDC, token1=WHBAR)
  const whbarPerUsdc = (rawPrice * 1e6) / 1e8; // human WHBAR per 1 USDC
  if (!Number.isFinite(whbarPerUsdc) || whbarPerUsdc <= 0) return undefined;
  const hbarUsd = 1 / whbarPerUsdc; // USD per HBAR (USDC pegged $1)
  if (hbarUsd < 1e-3 || hbarUsd > 10) return undefined; // sanity gate
  return hbarUsd;
}

/** Pool-sourced HBAR/USD (USDC/WHBAR V2 slot0) — the SAME rate the unzap swaps at. */
function usePoolHbarUsd(): number | undefined {
  const factoryRead = useReadContracts({
    contracts: [
      {
        abi: poolFloorFactoryAbi,
        address: POOL_FLOOR_FACTORY,
        functionName: "getPool",
        args: [POOL_FLOOR_USDC, POOL_FLOOR_WHBAR, POOL_FLOOR_FEE],
      } as const,
    ],
    allowFailure: true,
  });
  const pool =
    factoryRead.data?.[0]?.status === "success"
      ? (factoryRead.data[0].result as `0x${string}`)
      : undefined;
  const poolValid = !!pool && /^0x0*[1-9a-f]/i.test(pool);
  const slotRead = useReadContracts({
    contracts: poolValid
      ? [{ abi: poolFloorSlot0Abi, address: pool, functionName: "slot0" } as const]
      : [],
    query: { enabled: poolValid },
    allowFailure: true,
  });
  const sqrtP =
    slotRead.data?.[0]?.status === "success"
      ? (slotRead.data[0].result as readonly [bigint, ...unknown[]])[0]
      : undefined;
  return useMemo(
    () => (sqrtP !== undefined ? poolHbarUsdFromSqrtP(sqrtP) : undefined),
    [sqrtP],
  );
}

// F6: HashScan rejects a raw Hedera tx-id (`0.0.X@S.NS`) in the URL (400s).
// The canonical path form is `<acct>-<seconds>-<nanos>`. EVM `0x` hashes pass
// through unchanged.
function hashscanTxUrl(txId: string): string {
  if (txId.startsWith("0x")) {
    return `https://hashscan.io/mainnet/transaction/${txId}`;
  }
  const [acct, ts] = txId.split("@");
  if (acct && ts) {
    return `https://hashscan.io/mainnet/transaction/${acct}-${ts.replace(".", "-")}`;
  }
  return `https://hashscan.io/mainnet/transaction/${txId}`;
}
