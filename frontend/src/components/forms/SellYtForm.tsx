"use client";

/**
 * SellYtForm — exit a YT position pre-expiry by calling
 * `FissionMarket.swapExactYtForSy` directly on the Market. YT is freeze-by-
 * default and cannot be transferred to a Router, so the Market itself handles
 * the YT wipe + paired PT burn + SY payout in one atomic call.
 *
 * No approval step — the Market uses its WIPE key to destroy `ytIn` YT from
 * the caller. The user just signs the swap call.
 *
 * Post-expiry, YT has no SY claim in the rewards market (only PT redeems),
 * so the form auto-disables and points users to the residual-rewards-claim
 * path.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import type { MarketDetail } from "@/hooks/useMarket";
import { daysUntil, formatCompact, impliedApyPct } from "@/hooks/useMarkets";
import { ytToSyRate } from "@/components/MarketPositionCard";
import { useSyValueUsd } from "@/hooks/useSyValueUsd";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { computeSizeLimit, MAX_TRADE_PCT_OF_POOL } from "@/lib/trade-limits";
import { FlowOfFunds, type FlowStep } from "@/components/FlowOfFunds";
import { ADDRESSES, isDeployed, MAX_HTS_APPROVE } from "@/lib/addresses";
import { lensAbi } from "@/lib/abis";
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
  | { kind: "granting" } // step 0: market.setOperator(periphery, true) — one-time
  | { kind: "selling" } // step 1: market.swapExactYtForSy → user holds SY
  | { kind: "approving" } // step 2: approve SY → unzap (once per wallet)
  | { kind: "unzapping" } // step 3: unzap.unzapSy → user holds HBAR
  | { kind: "done"; finalTxHash: string }
  | { kind: "error"; message: string };

export function SellYtForm({ market, detail, user }: Props) {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const { usdPerShare } = useSyValueUsd(detail.sy);
  // SELL-MINHBAR-COINGECKO-01: pool-sourced HBAR/USD (USDC/WHBAR slot0) — the
  // SAME rate the unzap's inner swap executes at. Used to floor minHbarOut so
  // the floor is consistent with execution (never CoinGecko, which can diverge).
  // SellYt has no HBAR-denominated display, so no CoinGecko HBAR/USD is needed.
  const poolHbarUsd = usePoolHbarUsd();

  const [inputMode, setInputMode] = useState<"usd" | "raw">("usd");
  const [usdStr, setUsdStr] = useState("");
  const [rawStr, setRawStr] = useState("");
  // 50 bps (0.5%) default — with the FissionLens preview wired in below, the
  // syEstimate matches the chain's exact AMM output. The model-drift workaround
  // (5%/5% buffer) is no longer needed.
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

  const expired = Date.now() / 1000 >= Number(detail.expiry);

  // SY allowance toward the FissionUnzap — needed because the second leg
  // of Sell YT → HBAR is `unzap.unzapSy(sharesIn)` which pulls SY via
  // transferFrom. Set-once MAX allowance per wallet.
  const syAllowanceRead = useReadContracts({
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
            address: detail.syShare,
            functionName: "allowance",
            args: [user, ADDRESSES.periphery],
          } as const,
          // W2-04: operator grant on the market — the sell routes through the
          // operator-gated swapExactYtForSyFor; without it the Periphery reverts.
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
            args: [user, ADDRESSES.periphery],
          } as const,
          // SY-share balance — used to compute the post-Tx1 delta to unzap (W2-06).
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
  const syAllowance =
    syAllowanceRead.data?.[0]?.status === "success"
      ? (syAllowanceRead.data[0].result as bigint)
      : 0n;
  const isOperator =
    syAllowanceRead.data?.[1]?.status === "success"
      ? (syAllowanceRead.data[1].result as boolean)
      : false;
  const onChainSyShare =
    syAllowanceRead.data?.[2]?.status === "success"
      ? (syAllowanceRead.data[2].result as bigint)
      : 0n;

  /* ─────────────────────────── YT balance via contract-tracked view */

  // Read from `market.ytBalanceOf(user)` — the contract-tracked balance that
  // works for Ed25519 wallets too. (HTS facade `IERC20(yt).balanceOf` reverts
  // for long-zero EVM addresses of Ed25519 HAPI accounts.)
  const ytRead = useReadContracts({
    contracts: user
      ? [
          {
            abi: [
              {
                type: "function",
                name: "ytBalanceOf",
                stateMutability: "view",
                inputs: [{ name: "user", type: "address" }],
                outputs: [{ type: "uint256" }],
              },
            ] as const,
            address: market,
            functionName: "ytBalanceOf",
            args: [user],
          } as const,
        ]
      : [],
    query: { enabled: !!user },
    allowFailure: true,
  });
  const ytBalance =
    ytRead.data?.[0]?.status === "success" ? (ytRead.data[0].result as bigint) : 0n;
  // Detect a transient read failure (Hashio cache hiccup, RPC drop) so the
  // form doesn't dead-lock with "Insufficient YT — you have 0" while the user
  // actually holds a YT position. Same pattern as SellPtForm's Ed25519 guard.
  const ytBalanceReadFailed =
    ytRead.data?.[0]?.status === "failure" ||
    (ytRead.isError && ytBalance === 0n);

  /* ─────────────────────────── parsed input */

  // YT price (SY per 1 YT) = 1 - PT price. Used for USD↔raw conversion.
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);
  const ytPrice = ytToSyRate(apy, days);
  const usdPerYt =
    usdPerShare !== undefined && ytPrice > 0 ? usdPerShare * ytPrice : undefined;

  const parsedYt = useMemo<bigint>(() => {
    if (inputMode === "usd" && usdPerYt !== undefined) {
      return usdToRawBigInt(usdStr, usdPerYt);
    }
    return parseRawBigInt(rawStr);
  }, [inputMode, usdStr, rawStr, usdPerYt]);

  // Skip the local "insufficient" gate when the on-chain read failed — the
  // contract's own `_ytBal[msg.sender] < ytIn` check will revert authoritatively
  // if the user actually doesn't have enough YT.
  const insufficient = !ytBalanceReadFailed && parsedYt > ytBalance;
  // Sell YT depletes the AMM's PT inventory (PT is burned) → limit on totalPt.
  const sizeLimit = computeSizeLimit(parsedYt, detail.totalPt, detail.totalSy);

  /* ─────────────────────────── SY estimate via FissionLens (exact curve) */

  // Call lens.previewSwapExactYtForSy(market, ytIn) to get the chain's exact
  // AMM output for this trade size. Falls back to the simple-interest linear
  // model (1 - ptRate) only if the lens isn't deployed in this env.
  const lensReady = isDeployed(ADDRESSES.lens) && parsedYt > 0n;
  const lensRead = useReadContracts({
    contracts: lensReady
      ? [
          {
            abi: lensAbi,
            address: ADDRESSES.lens,
            functionName: "previewSwapExactYtForSy",
            args: [market, parsedYt],
          } as const,
        ]
      : [],
    query: { enabled: lensReady },
    allowFailure: true,
  });
  const lensSyOut =
    lensRead.data?.[0]?.status === "success"
      ? (lensRead.data[0].result as readonly [bigint, bigint])[0]
      : undefined;
  // Linear fallback only if lens unavailable. With the lens wired in production,
  // this branch is dead unless someone runs the dApp against an env without
  // NEXT_PUBLIC_LENS_ADDRESS — slippage default still works against the model.
  const linearEstimate =
    parsedYt > 0n && ytPrice > 0
      ? BigInt(Math.floor(Number(parsedYt) * ytPrice * 0.95))
      : 0n;
  const syEstimate = lensSyOut ?? linearEstimate;
  const minSyOut = (syEstimate * BigInt(10_000 - slippageBps)) / 10_000n;

  // F3/F4 + SELL-MINHBAR-COINGECKO-01: the Tx3 unzap (SY → HBAR) needs a
  // trustworthy minHbarOut floor — a 1n floor is sandwich-exploitable (the inner
  // USDC→WHBAR leg uses amountOutMinimum:0). The floor is now sourced from
  // `poolHbarUsd` (the SaucerSwap V2 USDC/WHBAR slot0 — the rate the unzap
  // actually swaps at), NOT CoinGecko's `hbarUsd`, so the floor is consistent
  // with execution. Both `usdPerShare` and `poolHbarUsd` are CoinGecko-
  // independent on-chain reads, so a blocked/429ing CoinGecko no longer trips
  // this — we only hard-block when the on-chain pool read itself fails. Blocking
  // here prevents wiping the YT and then being unable to price the Tx3 floor.
  const priceFeedUnavailable =
    parsedYt > 0n && (usdPerShare === undefined || poolHbarUsd === undefined);

  /* ─────────────────────────── primary handler (3-step YT → HBAR chain) */

  // YT → HBAR requires THREE user signatures (vs PT/LP's one) because YT is
  // HTS-frozen and can only be wiped by the market when msg.sender holds
  // the YT. The unzap can't proxy that wipe, so the user must call
  // market.swapExactYtForSy themselves first; only then can the unzap
  // pull their SY for the unwrap leg.
  //
  // Chain:
  //   1. market.swapExactYtForSy(receiver=user)         → user holds SY
  //   2. IERC20(SY).approve(unzap, MAX)  (once-ever)    → set permission
  //   3. unzap.unzapSy(sy, minSyOut, 1, receiver=user)  → HBAR in wallet
  //
  // W2-06: after step 1 ships, the user holds the realized SY (≥minSyOut). We
  // read the post-sell SY-share delta and unzap THAT (not just minSyOut, which
  // left surplus stranded), with a slippage-derived minHbarOut floor.
  const chainInFlight = useRef(false);
  const onPrimary = useCallback(async () => {
    if (chainInFlight.current) return;
    if (!user || parsedYt === 0n || expired) return;
    if (insufficient || sizeLimit.exceeded) return;
    // F3/F4 + SELL-MINHBAR-COINGECKO-01: refuse to start a sell we can't floor.
    // The Tx3 unzap floor is sourced from `poolHbarUsd` (the SaucerSwap pool
    // rate the swap executes at), so gate on it being present — not CoinGecko.
    // This only fires when the on-chain pool read is down.
    if (usdPerShare === undefined || poolHbarUsd === undefined) {
      setWriteError("Price feed unavailable — can't safely set a minimum HBAR floor for the SY→HBAR conversion. Try again once pricing is back.");
      return;
    }
    chainInFlight.current = true;
    setWriteError(null);
    try {
      // SELL-NO-SYSHARE-ASSOC / REALUSE-01: Step 1 (sellYtForSy) delivers
      // SY-share to the user via safeTransfer. On a HIP-904 limited-association
      // wallet (max_auto=0) that has never held SY-share, that transfer reverts
      // TOKEN_NOT_ASSOCIATED (184) at consensus (invisible to eth_call) — AFTER
      // the YT was already wiped. The Buy forms pre-associate [syShare,…]; this
      // path did not. The Step-3 unzap delivers native HBAR (no association
      // needed), so SY-share is the only delivered token to precheck. Precheck
      // in BOTH modes:
      //   • Hedera mode: auto-associate the missing token(s) (one prompt).
      //   • EVM mode: MetaMask CANNOT submit a Hedera TokenAssociate tx, so
      //     resolve the EVM address → 0.0.id via mirror, check associations, and
      //     BLOCK rather than let Step 1 wipe the YT and its delivery revert.
      // No-op for HIP-904-unlimited wallets / unresolved accounts.
      {
        const { getMissingAssociations, associateTokens, evmAddressToTokenId } =
          await import("@/lib/hedera-wallet/associations");
        const ids = [detail.syShare].map(evmAddressToTokenId);

        if (adapter.mode === "hedera" && adapter.accountId) {
          const missing = await getMissingAssociations(adapter.accountId, ids);
          if (missing.length > 0) {
            await associateTokens(hedera.getConnector(), adapter.accountId, missing);
            await syAllowanceRead.refetch();
          }
        } else if (adapter.mode === "evm" && adapter.address) {
          const accountId = await evmAddressToAccountId(adapter.address);
          if (accountId) {
            const missing = await getMissingAssociations(accountId, ids);
            if (missing.length > 0) {
              const msg =
                `Your account hasn't associated the SY-share token (${missing.join(", ")}). ` +
                "MetaMask can't submit a Hedera token-association, so this sell can't " +
                "deliver to you. Enable automatic token associations in your wallet, or " +
                "associate the token first (e.g. in HashPack), then retry.";
              setWriteError(msg);
              setFlowState({ kind: "error", message: msg });
              return;
            }
          }
        }
      }

      // Post-rebuild (2026-05-27): 2-tx Periphery flow.
      //
      // Step 0 (W2-04): market.setOperator(periphery, true) — one-time per
      //         wallet. sellYtForSy calls market.swapExactYtForSyFor(user, …)
      //         which reverts (NotAuthorized) until the Periphery is operator.
      //         There was previously no grant UX, so any user who hadn't run it
      //         manually couldn't sell. Grant it inline.
      if (!isOperator) {
        setFlowState({ kind: "granting" });
        const gResp = await adapter.write({
          kind: "marketSetOperator",
          market,
          operator: ADDRESSES.periphery,
          approved: true,
        });
        setLastTxHash(gResp.txHash);
        await new Promise((r) => setTimeout(r, adapter.mode === "evm" ? 3500 : 1500));
        await syAllowanceRead.refetch();
      }

      // Snapshot SY-share balance pre-sell so we can unzap the exact delta.
      let preSell: bigint = onChainSyShare;
      try {
        const r = await syAllowanceRead.refetch();
        if (r.data?.[2]?.status === "success") preSell = r.data[2].result as bigint;
      } catch {
        /* fall back to cached */
      }

      // Step 1: Periphery.sellYtForSy — Periphery calls market.swapExactYtForSyFor(user, …)
      //         using the user's operator approval; wipes user's YT; sends SY to `user`.
      setFlowState({ kind: "selling" });
      const sellResp = await adapter.write({
        kind: "writePeriphery",
        functionName: "sellYtForSy",
        args: [market, parsedYt, minSyOut, user, 0n],
      });
      setLastTxHash(sellResp.txHash);

      // Read realized SY-share delta (Hashio mirror lag-aware). Falls back to
      // the lens estimate if we never see movement.
      await new Promise((r) => setTimeout(r, adapter.mode === "evm" ? 3500 : 1500));
      let syReceived: bigint = syEstimate;
      for (let i = 0; i < 5; i++) {
        try {
          const r = await syAllowanceRead.refetch();
          const fresh = r.data?.[2]?.status === "success" ? (r.data[2].result as bigint) : preSell;
          if (fresh > preSell) {
            syReceived = fresh - preSell;
            break;
          }
        } catch {
          /* retry */
        }
        await new Promise((res) => setTimeout(res, 1000));
      }

      // Step 2: approve SY → Periphery if allowance below the amount we'll pull.
      if (syAllowance < syReceived) {
        setFlowState({ kind: "approving" });
        const aResp = await adapter.write({
          kind: "approveErc20",
          token: detail.syShare,
          spender: ADDRESSES.periphery,
          amount: MAX_HTS_APPROVE,
        });
        setLastTxHash(aResp.txHash);
        await new Promise((r) => setTimeout(r, adapter.mode === "evm" ? 3500 : 1500));
        await syAllowanceRead.refetch();
      }

      // Step 3: Periphery.unzapSyToHbar — full SY delta → HBAR delivered to user.
      // SELL-03 + F3 + SELL-MINHBAR-COINGECKO-01: derive minHbarOut from the
      // REALIZED syReceived delta (not a pre-trade estimate) using the POOL-sourced
      // HBAR/USD — the SAME rate the unzap's inner USDC→WHBAR swap executes at
      // (amountOutMinimum:0). Pricing off CoinGecko would let a divergence revert
      // this Tx AFTER the YT was already wiped; `poolHbarUsd` keeps the floor
      // consistent with execution. We gated on it being present above, so this is
      // never the 1n fallback.
      const hbarForDelta = (Number(syReceived) * usdPerShare) / Math.max(1e-9, poolHbarUsd);
      const minHbarOut =
        (BigInt(Math.floor(hbarForDelta * 1e8)) * BigInt(10_000 - slippageBps)) / 10_000n;
      if (minHbarOut <= 0n) {
        const msg =
          "Computed HBAR floor rounded to zero — refusing to send an unprotected unzap. Your YT is now SY in your wallet; convert it once pricing/size allows.";
        setWriteError(msg);
        setFlowState({ kind: "error", message: msg });
        return;
      }
      setFlowState({ kind: "unzapping" });
      const uResp = await adapter.write({
        kind: "writePeriphery",
        functionName: "unzapSyToHbar",
        args: [detail.sy, syReceived, minHbarOut, 0n],
      });
      setLastTxHash(uResp.txHash);
      setFlowState({ kind: "done", finalTxHash: uResp.txHash });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWriteError(msg);
      setFlowState({ kind: "error", message: msg });
    } finally {
      chainInFlight.current = false;
    }
  }, [adapter, detail.sy, detail.syShare, expired, poolHbarUsd, hedera, insufficient, isOperator, market, minSyOut, onChainSyShare, parsedYt, sizeLimit.exceeded, slippageBps, syAllowance, syAllowanceRead, syEstimate, usdPerShare, user]);

  const isPending =
    adapter.isWritePending ||
    flowState.kind === "granting" ||
    flowState.kind === "selling" ||
    flowState.kind === "approving" ||
    flowState.kind === "unzapping";
  const isDoneFinal = flowState.kind === "done";

  /* ─────────────────────────── FlowOfFunds */

  const flowSteps: FlowStep[] = [
    {
      label: "You sell",
      detail: "Connected wallet → Market (wipe)",
      inToken:
        parsedYt > 0n
          ? {
              sym: "YT",
              amount: formatCompact(parsedYt),
              usd:
                usdPerYt !== undefined
                  ? `≈ $${(Number(parsedYt) * usdPerYt).toFixed(2)}`
                  : undefined,
            }
          : undefined,
      isComplete: isDoneFinal,
    },
    {
      label: "Fission Market",
      detail: `wipe YT · burn pool PT · swapExactYtForSy`,
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
    if (expired) return "Market expired — YT has no SY claim";
    if (parsedYt === 0n) return "Enter amount";
    if (insufficient) return "Insufficient YT";
    if (sizeLimit.exceeded) return "Trade too large for pool";
    if (priceFeedUnavailable) return "Price feed unavailable — try again";
    if (flowState.kind === "error") return "Retry Sell YT → HBAR";
    if (flowState.kind === "granting") return "Enabling selling…";
    if (flowState.kind === "selling") return "1/3 · Selling YT for SY…";
    if (flowState.kind === "approving") return "2/3 · Approving SY for unzap…";
    if (flowState.kind === "unzapping") return "3/3 · Unwrapping SY → HBAR…";
    if (flowState.kind === "done") return "✓ Done — HBAR in wallet";
    if (isConfirmingFinal) return "Waiting for confirmation…";
    // Prompt count includes the one-time operator grant + SY approval when not
    // yet set, plus the sell + unzap (the existing "(N prompts)" copy pattern).
    {
      const prompts = 2 + (isOperator ? 0 : 1) + (syAllowance < minSyOut ? 1 : 0);
      return `Sell YT for HBAR (${prompts} prompts)`;
    }
  };

  const buttonDisabled =
    !user ||
    isPending ||
    isConfirmingFinal ||
    expired ||
    parsedYt === 0n ||
    insufficient ||
    sizeLimit.exceeded ||
    // F3: block the sell while we can't price the SY→HBAR leg.
    priceFeedUnavailable;

  const poolHealthy = !sizeLimit.exceeded && sizeLimit.poolDepth > 0n;

  return (
    <div className="flex flex-col gap-3">
      <FlowOfFunds title="Flow of funds · Sell YT" steps={flowSteps} />

      <div className="rounded-2xl border border-border bg-bgCard p-4">
        <FormHeaderStrip
          name="Sell YT"
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
            Market expired — YT has no SY claim in this market. Hold and claim
            any residual rewards instead.
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
          parsedRaw={parsedYt}
          balance={ytBalance}
          tokenSym="YT"
          label="You sell"
          usdPerUnit={usdPerYt}
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
              {" · "}gas ~0.12 HBAR
            </>
          }
          feedback={
            insufficient ? (
              <span className="block font-mono text-[10px] font-medium text-error">
                Insufficient YT — you have {formatCompact(ytBalance)}.
              </span>
            ) : ytBalanceReadFailed ? (
              <span className="block font-mono text-[10px] font-medium text-warning">
                YT balance read failed — your tx will revert on-chain if you
                don&apos;t actually hold this YT.
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

        <p className="mt-2 font-mono text-[10px] leading-relaxed text-textDim">
          No approval needed — the Market holds the WIPE key on YT and consumes
          your balance directly.
        </p>

        {writeError && (
          <div className="mt-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-error">
            {writeError.slice(0, 240)}
          </div>
        )}

        {flowState.kind === "done" && lastTxHash && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-success">
            <div className="font-semibold uppercase tracking-[1px]">YT sold for HBAR.</div>
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
                  void ytRead.refetch();
                }}
                className="underline underline-offset-2 hover:text-text"
              >
                New trade
              </button>
            </div>
          </div>
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
 * CoinGecko's hbarUsd lets a CoinGecko-underprices-pool divergence revert the
 * unzap AFTER the YT was already wiped. So the floor must come from the SAME
 * source the swap uses: the pool's slot0. This local hook reads the USDC/WHBAR
 * V2 pool slot0 directly — identical math/constants to useSyValueUsd's on-chain
 * fallback — so the floor is consistent with execution. (A parallel agent
 * exposes the same value as `poolHbarUsd` on the price hook; this self-contained
 * copy is equivalent and avoids coupling to a not-yet-landed export.) */
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
