"use client";

/**
 * useWalletAdapter — unified wallet hook that hides the wagmi-vs-Hedera-native
 * split from the rest of the app. Components ask the adapter to "do this op"
 * (split, buyPT, zap, approve, redeem) and the adapter picks the right
 * signing/encoding path based on which connector the user picked.
 *
 *   - EVM mode    → wagmi.useWriteContract + Hashio JSON-RPC
 *   - Hedera mode → @hashgraph/sdk ContractExecuteTransaction +
 *                    @hashgraph/hedera-wallet-connect DAppSigner
 *
 * Same contracts on the receiving end (FissionFactory, FissionMarketRewards,
 * FissionZap, ActionRouter, SY_SaucerSwapV2LP, plus HTS tokens). Only the
 * wire format and msg.value units differ between paths.
 */

import { useCallback, useMemo } from "react";
import { useAccount, useChainId, useDisconnect, useWriteContract, useSignMessage } from "wagmi";
import { parseEther } from "viem";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { useHederaWallet } from "./provider";
import {
  erc20WriteAbi,
  routerAbi,
  marketWriteAbi,
  syWriteAbi,
  fissionZapAbi,
  megaZapAbi,
  fissionUnzapAbi,
} from "@/lib/abis-write";

export type WriteOp =
  | { kind: "approveErc20"; token: `0x${string}`; spender: `0x${string}`; amount: bigint }
  | { kind: "split"; market: `0x${string}`; amount: bigint }
  | { kind: "merge"; market: `0x${string}`; amount: bigint }
  | {
      kind: "swapExactSyForPt";
      router: `0x${string}`;
      market: `0x${string}`;
      syIn: bigint;
      minPtOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
    }
  | {
      kind: "buyYT";
      router: `0x${string}`;
      market: `0x${string}`;
      syBudget: bigint;
      minSyOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
    }
  | {
      kind: "swapExactPtForSy";
      router: `0x${string}`;
      market: `0x${string}`;
      ptIn: bigint;
      minSyOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
    }
  | {
      // Sell YT — called directly on the Market (YT is frozen, can't proxy via Router).
      // The Market wipes the user's YT in-place using its WIPE key.
      kind: "swapExactYtForSy";
      market: `0x${string}`;
      ytIn: bigint;
      minSyOut: bigint;
      receiver: `0x${string}`;
    }
  | {
      kind: "zapHbarToSy";
      zap: `0x${string}`;
      sy: `0x${string}`;
      receiver: `0x${string}`;
      /** User-typed HBAR amount (excluding NPM fee — adapter adds it). */
      hbarIn: number;
    }
  | {
      kind: "depositLiquidity";
      sy: `0x${string}`;
      amount0: bigint;
      amount1: bigint;
      amount0Min: bigint;
      amount1Min: bigint;
      receiver: `0x${string}`;
      minShares: bigint;
      /** HBAR forwarded for the V3 NPM fee. */
      npmHbar: number;
    }
  | {
      kind: "redeemAfterExpiry";
      market: `0x${string}`;
      ptIn: bigint;
      ytIn: bigint;
      receiver: `0x${string}`;
    }
  | {
      kind: "addLiquidity";
      router: `0x${string}`;
      market: `0x${string}`;
      syIn: bigint;
      ptIn: bigint;
      minLpOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
    }
  | {
      kind: "removeLiquidity";
      router: `0x${string}`;
      market: `0x${string}`;
      lpIn: bigint;
      minSyOut: bigint;
      minPtOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
    }
  | {
      kind: "zapHbarToPtMega";
      megaZap: `0x${string}`;
      market: `0x${string}`;
      sy: `0x${string}`;
      minPtOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
      /** User-typed HBAR amount (excluding NPM fee — adapter adds it). */
      hbarIn: number;
    }
  | {
      kind: "zapHbarToYtMega";
      megaZap: `0x${string}`;
      market: `0x${string}`;
      sy: `0x${string}`;
      minSyOutFromPtSale: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
      hbarIn: number;
    }
  | {
      kind: "zapHbarToLpMega";
      megaZap: `0x${string}`;
      market: `0x${string}`;
      sy: `0x${string}`;
      /** Basis points of SY budget converted to PT (5000 = 50/50). */
      ptShareBps: number;
      minLpOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
      hbarIn: number;
    }
  // FissionUnzap ops: 1-tx PT/LP/SY → native HBAR.
  | {
      kind: "sellPtForHbar";
      unzap: `0x${string}`;
      market: `0x${string}`;
      ptIn: bigint;
      minHbarOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
    }
  | {
      kind: "unzapSy";
      unzap: `0x${string}`;
      sy: `0x${string}`;
      sharesIn: bigint;
      minHbarOut: bigint;
      receiver: `0x${string}`;
    }
  | {
      kind: "sellLpForHbar";
      unzap: `0x${string}`;
      market: `0x${string}`;
      lpIn: bigint;
      minHbarOut: bigint;
      receiver: `0x${string}`;
      deadline: bigint;
    };

interface AdapterState {
  mode: "evm" | "hedera" | null;
  isConnected: boolean;
  address: `0x${string}` | null;
  accountId: string | null; // Hedera "0.0.X" when in hedera mode
  chainId: number | null;
}

export interface AdapterAPI extends AdapterState {
  /** Returns a tx-hash-shaped string on submit; receipt waiting handled by caller. */
  write: (op: WriteOp) => Promise<{ txHash: string }>;
  /** Sign a SIWE-style message. The returned format tells /api/auth/verify which verifier to use. */
  signMessage: (message: string) => Promise<
    | { format: "eip191"; signature: `0x${string}` }
    | { format: "hedera"; signatureMap: string; accountId: string }
  >;
  disconnect: () => Promise<void>;
  /** Imperative flag used by the Mint-SY tx-pending UI. The actual receipt-waiting hook lives in components. */
  isWritePending: boolean;
}

/**
 * The adapter prefers EVM mode when both connectors have an active session
 * (we shipped EVM first; users with it already wired keep using it). New
 * connects via the "Hedera native" button set mode='hedera'.
 */
export function useWalletAdapter(): AdapterAPI {
  // EVM (wagmi) state
  const wagmiAcct = useAccount();
  const wagmiChainId = useChainId();
  const { writeContractAsync, isPending: isEvmWritePending } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const { disconnectAsync: disconnectEvm } = useDisconnect();

  // Hedera state
  const hedera = useHederaWallet();

  const mode: "evm" | "hedera" | null =
    hedera.status === "connected"
      ? "hedera"
      : wagmiAcct.isConnected && wagmiAcct.address
        ? "evm"
        : null;

  const address: `0x${string}` | null =
    mode === "hedera"
      ? hedera.evmAddress
      : mode === "evm"
        ? (wagmiAcct.address as `0x${string}`)
        : null;

  const write = useCallback(
    async (op: WriteOp): Promise<{ txHash: string }> => {
      if (mode === "evm") {
        return writeEvm(op, writeContractAsync);
      }
      if (mode === "hedera") {
        return writeHedera(op, hedera.getConnector());
      }
      throw new Error("Wallet not connected");
    },
    [mode, writeContractAsync, hedera],
  );

  const signMessage = useCallback(
    async (message: string) => {
      if (mode === "evm") {
        const sig = await signMessageAsync({ message });
        return { format: "eip191" as const, signature: sig as `0x${string}` };
      }
      if (mode === "hedera") {
        const connector = hedera.getConnector() as null | {
          signMessage(params: { signerAccountId: string; message: string }): Promise<{ signatureMap: string }>;
        };
        if (!connector) throw new Error("Hedera connector not initialized");
        const accountId = hedera.accountId;
        if (!accountId) throw new Error("Hedera accountId missing");
        const { signatureMap } = await connector.signMessage({
          signerAccountId: `hedera:mainnet:${accountId}`,
          message,
        });
        return { format: "hedera" as const, signatureMap, accountId };
      }
      throw new Error("Wallet not connected");
    },
    [mode, signMessageAsync, hedera],
  );

  const disconnect = useCallback(async () => {
    if (mode === "hedera") {
      await hedera.disconnect();
    } else if (mode === "evm") {
      await disconnectEvm();
    }
  }, [mode, hedera, disconnectEvm]);

  return useMemo<AdapterAPI>(
    () => ({
      mode,
      isConnected: mode !== null,
      address,
      accountId: mode === "hedera" ? hedera.accountId : null,
      chainId: mode === "evm" ? wagmiChainId : mode === "hedera" ? HEDERA_MAINNET_CHAIN_ID : null,
      write,
      signMessage,
      disconnect,
      isWritePending: isEvmWritePending,
    }),
    [mode, address, hedera.accountId, wagmiChainId, write, signMessage, disconnect, isEvmWritePending],
  );
}

/* ───────────────────────────────────────────────────────── EVM path */

async function writeEvm(
  op: WriteOp,
  writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"],
): Promise<{ txHash: string }> {
  switch (op.kind) {
    case "approveErc20":
      return {
        txHash: await writeContractAsync({
          abi: erc20WriteAbi,
          address: op.token,
          functionName: "approve",
          args: [op.spender, op.amount],
        }),
      };
    case "split":
      return {
        txHash: await writeContractAsync({
          abi: marketWriteAbi,
          address: op.market,
          functionName: "split",
          args: [op.amount],
        }),
      };
    case "merge":
      return {
        txHash: await writeContractAsync({
          abi: marketWriteAbi,
          address: op.market,
          functionName: "merge",
          args: [op.amount],
        }),
      };
    case "swapExactSyForPt":
      return {
        txHash: await writeContractAsync({
          abi: routerAbi,
          address: op.router,
          functionName: "swapExactSyForPt",
          args: [op.market, op.syIn, op.minPtOut, op.receiver, op.deadline],
        }),
      };
    case "buyYT":
      return {
        txHash: await writeContractAsync({
          abi: routerAbi,
          address: op.router,
          functionName: "buyYT",
          args: [op.market, op.syBudget, op.minSyOut, op.receiver, op.deadline],
        }),
      };
    case "swapExactPtForSy":
      return {
        txHash: await writeContractAsync({
          abi: routerAbi,
          address: op.router,
          functionName: "swapExactPtForSy",
          args: [op.market, op.ptIn, op.minSyOut, op.receiver, op.deadline],
        }),
      };
    case "swapExactYtForSy":
      return {
        txHash: await writeContractAsync({
          abi: marketWriteAbi,
          address: op.market,
          functionName: "swapExactYtForSy",
          args: [op.ytIn, op.minSyOut, op.receiver],
        }),
      };
    case "zapHbarToSy": {
      // Hashio takes wei (1 HBAR = 1e18); Hashio divides by 1e10 before the
      // contract, which then sees tinybars. parseEther = wei.
      return {
        txHash: await writeContractAsync({
          abi: fissionZapAbi,
          address: op.zap,
          functionName: "zapHbarToSy",
          args: [op.sy, 0n, 0n, 0n, 1n, op.receiver],
          value: parseEther(String(op.hbarIn + 5)), // +5 HBAR NPM
        }),
      };
    }
    case "depositLiquidity":
      return {
        txHash: await writeContractAsync({
          abi: syWriteAbi,
          address: op.sy,
          functionName: "depositLiquidity",
          args: [op.amount0, op.amount1, op.amount0Min, op.amount1Min, op.receiver, op.minShares],
          value: parseEther(String(op.npmHbar)),
        }),
      };
    case "redeemAfterExpiry":
      return {
        txHash: await writeContractAsync({
          abi: marketWriteAbi,
          address: op.market,
          functionName: "redeemAfterExpiry",
          args: [op.ptIn, op.ytIn, op.receiver],
        }),
      };
    case "addLiquidity":
      // ActionRouter v3 (2026-05-14) fixes the SY-share typing bug from v2
      // — the router now pulls `sy.shareToken()` correctly, so the dApp
      // routes Add LP through the router again (matches Remove LP).
      // Approvals are on the SY-share + PT toward the router, not the
      // market. v2 deployments without a v3 redeploy will revert here.
      return {
        txHash: await writeContractAsync({
          abi: routerAbi,
          address: op.router,
          functionName: "addLiquidityProportional",
          args: [op.market, op.syIn, op.ptIn, op.minLpOut, op.receiver, op.deadline],
        }),
      };
    case "removeLiquidity":
      return {
        txHash: await writeContractAsync({
          abi: routerAbi,
          address: op.router,
          functionName: "removeLiquidityProportional",
          args: [op.market, op.lpIn, op.minSyOut, op.minPtOut, op.receiver, op.deadline],
        }),
      };
    case "zapHbarToPtMega":
      return {
        txHash: await writeContractAsync({
          abi: megaZapAbi,
          address: op.megaZap,
          functionName: "zapHbarToPt",
          args: [op.market, op.sy, op.minPtOut, op.receiver, op.deadline],
          value: parseEther(String(op.hbarIn + 5)), // +5 HBAR NPM fee
        }),
      };
    case "zapHbarToYtMega":
      return {
        txHash: await writeContractAsync({
          abi: megaZapAbi,
          address: op.megaZap,
          functionName: "zapHbarToYt",
          args: [op.market, op.sy, op.minSyOutFromPtSale, op.receiver, op.deadline],
          value: parseEther(String(op.hbarIn + 5)),
        }),
      };
    case "zapHbarToLpMega":
      return {
        txHash: await writeContractAsync({
          abi: megaZapAbi,
          address: op.megaZap,
          functionName: "zapHbarToLp",
          args: [op.market, op.sy, op.ptShareBps, op.minLpOut, op.receiver, op.deadline],
          value: parseEther(String(op.hbarIn + 5)),
        }),
      };
    case "sellPtForHbar":
      return {
        txHash: await writeContractAsync({
          abi: fissionUnzapAbi,
          address: op.unzap,
          functionName: "sellPtForHbar",
          args: [op.market, op.ptIn, op.minHbarOut, op.receiver, op.deadline],
        }),
      };
    case "unzapSy":
      return {
        txHash: await writeContractAsync({
          abi: fissionUnzapAbi,
          address: op.unzap,
          functionName: "unzapSy",
          args: [op.sy, op.sharesIn, op.minHbarOut, op.receiver],
        }),
      };
    case "sellLpForHbar":
      return {
        txHash: await writeContractAsync({
          abi: fissionUnzapAbi,
          address: op.unzap,
          functionName: "sellLpForHbar",
          args: [op.market, op.lpIn, op.minHbarOut, op.receiver, op.deadline],
        }),
      };
  }
}

/* ─────────────────────────────────────────────────────── Hedera path */

async function writeHedera(op: WriteOp, connectorMaybe: unknown): Promise<{ txHash: string }> {
  const connector = connectorMaybe as null | {
    signers: Array<{ getAccountId(): { toString(): string } }>;
  };
  if (!connector || !connector.signers?.length) {
    throw new Error("Hedera connector has no signer");
  }
  const signer = connector.signers[0];

  // Lazy-load the SDK so it doesn't sit in the initial bundle.
  const sdk = await import("@hashgraph/sdk");
  const { ContractExecuteTransaction, ContractFunctionParameters, ContractId, Hbar, AccountId, Client } = sdk;
  // bignumber.js is the SDK's accepted form for uint256/uint128 params.
  const { default: BigNumber } = await import("bignumber.js");

  const toBN = (v: bigint): InstanceType<typeof BigNumber> => new BigNumber(v.toString());

  // DAppSigner.populateTransaction (from @hashgraph/hedera-wallet-connect)
  // only sets the transaction ID, not the node account IDs. Then
  // tx.freezeWithSigner internally calls tx.freeze(null) which throws
  // "nodeAccountId must be set or client must be provided with freezeWith".
  //
  // Workaround: build a mainnet Client purely for its node list and pass
  // those IDs to setNodeAccountIds before freezing. The client is never
  // used to execute — DAppSigner submits via WalletConnect — but it
  // satisfies the SDK's pre-freeze invariant.
  const mainnetClient = Client.forMainnet();
  const nodeIds: InstanceType<typeof AccountId>[] = mainnetClient._network
    ? (mainnetClient._network.getNodeAccountIdsForExecute?.() as InstanceType<typeof AccountId>[]) ?? []
    : [];
  mainnetClient.close();

  // Fetch the current ContractCall gas rate (tinybar/gas) from mirror
  // node. Hedera updates this with each hourly exchange-rate cycle, so
  // we re-query on EVERY tx — no caching. ~100-200ms extra round-trip per
  // signature but guarantees the maxTransactionFee never drifts from the
  // protocol's live rate. Fallback 200 tinybar/gas (≈2× current rate) if
  // the endpoint is down — still safe; bloats maxFee but doesn't reject.
  const fetchTinybarPerGas = async (): Promise<number> => {
    try {
      const r = await fetch(
        "https://mainnet-public.mirrornode.hedera.com/api/v1/network/fees",
        { cache: "no-store" },
      );
      const j = (await r.json()) as { fees?: { gas: number; transaction_type: string }[] };
      const ccFee = j.fees?.find((f) => f.transaction_type === "ContractCall");
      if (ccFee?.gas && ccFee.gas > 0) return ccFee.gas;
    } catch {
      /* fall through */
    }
    return 200;
  };

  const cid = (addr: `0x${string}`) => ContractId.fromEvmAddress(0, 0, addr);
  const exec = async (
    contractAddress: `0x${string}`,
    functionName: string,
    params: InstanceType<typeof ContractFunctionParameters>,
    payableHbar: number,
    gas: number,
  ): Promise<{ txHash: string }> => {
    // maxTransactionFee = gasLimit × LIVE network gas-rate × 1.3 buffer.
    // Buffer absorbs short-window rate spikes between our query and the
    // wallet's own check. If the actual gas-used × rate exceeds this
    // ceiling the tx fails with INSUFFICIENT_TX_FEE (clear failure mode
    // we can show to the user), instead of the confusing wallet-side
    // INSUFFICIENT_PAYER_BALANCE that masquerades as "no funds".
    //
    // Without explicit setMaxTransactionFee, HashPack applies its own
    // heuristic that has been observed to exceed user balance even when
    // the actual cost would fit (live capture 2026-05-25: code 10
    // INSUFFICIENT_PAYER_BALANCE on a Buy YT step the user had plenty
    // of HBAR for). Setting it explicitly forces deterministic pre-charge.
    const tinybarPerGas = await fetchTinybarPerGas();
    const maxFeeTinybar = BigInt(Math.ceil(gas * tinybarPerGas * 1.3));
    const tx = new ContractExecuteTransaction()
      .setContractId(cid(contractAddress))
      .setGas(gas)
      .setMaxTransactionFee(Hbar.fromTinybars(maxFeeTinybar.toString()))
      .setFunction(functionName, params);
    if (payableHbar > 0) {
      // `new Hbar(n)` rejects floats with "Hbar in tinybars contains decimals".
      // Round to whole tinybars (1 HBAR = 1e8 tinybars) before passing.
      const tinybars = BigInt(Math.floor(payableHbar * 1e8));
      tx.setPayableAmount(Hbar.fromTinybars(tinybars.toString()));
    }
    if (nodeIds.length > 0) tx.setNodeAccountIds(nodeIds);
    await tx.freezeWithSigner(signer as never);
    const resp = await tx.executeWithSigner(signer as never);
    // Wait for receipt so callers can rely on the tx being finalized.
    // If the contract reverted we get a StatusError with the Hedera tx
    // ID — fetch the encoded revert reason from Mirror Node and rethrow
    // with something the user can actually act on.
    try {
      await resp.getReceiptWithSigner(signer as never);
    } catch (e) {
      const txId = resp.transactionId?.toString() ?? "";
      const decoded = await decodeRevert(txId);
      if (decoded) {
        const err = new Error(decoded);
        (err as { cause?: unknown }).cause = e;
        throw err;
      }
      throw e;
    }
    return { txHash: resp.transactionId?.toString() ?? "" };
  };

  switch (op.kind) {
    case "approveErc20":
      return exec(
        op.token,
        "approve",
        new ContractFunctionParameters().addAddress(op.spender).addUint256(toBN(op.amount)),
        0,
        800_000,
      );
    case "split":
      return exec(
        op.market,
        "split",
        new ContractFunctionParameters().addUint256(toBN(op.amount)),
        0,
        2_000_000,
      );
    case "merge":
      return exec(
        op.market,
        "merge",
        new ContractFunctionParameters().addUint256(toBN(op.amount)),
        0,
        2_000_000,
      );
    case "swapExactSyForPt":
      return exec(
        op.router,
        "swapExactSyForPt",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.syIn))
          .addUint256(toBN(op.minPtOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        0,
        3_500_000,
      );
    case "buyYT":
      return exec(
        op.router,
        "buyYT",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.syBudget))
          .addUint256(toBN(op.minSyOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        0,
        4_000_000,
      );
    case "swapExactPtForSy":
      return exec(
        op.router,
        "swapExactPtForSy",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.ptIn))
          .addUint256(toBN(op.minSyOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        0,
        3_500_000,
      );
    case "swapExactYtForSy":
      return exec(
        op.market,
        "swapExactYtForSy",
        new ContractFunctionParameters()
          .addUint256(toBN(op.ytIn))
          .addUint256(toBN(op.minSyOut))
          .addAddress(op.receiver),
        0,
        4_500_000,
      );
    case "zapHbarToSy":
      return exec(
        op.zap,
        "zapHbarToSy",
        new ContractFunctionParameters()
          .addAddress(op.sy)
          .addUint256(toBN(0n))
          .addUint256(toBN(0n))
          .addUint256(toBN(0n))
          .addUint128(toBN(1n))
          .addAddress(op.receiver),
        op.hbarIn + 5, // user input + 5 HBAR NPM fee, in whole HBAR
        14_500_000,
      );
    case "depositLiquidity":
      return exec(
        op.sy,
        "depositLiquidity",
        new ContractFunctionParameters()
          .addUint256(toBN(op.amount0))
          .addUint256(toBN(op.amount1))
          .addUint256(toBN(op.amount0Min))
          .addUint256(toBN(op.amount1Min))
          .addAddress(op.receiver)
          .addUint128(toBN(op.minShares)),
        op.npmHbar,
        14_500_000,
      );
    case "redeemAfterExpiry":
      return exec(
        op.market,
        "redeemAfterExpiry",
        new ContractFunctionParameters()
          .addUint256(toBN(op.ptIn))
          .addUint256(toBN(op.ytIn))
          .addAddress(op.receiver),
        0,
        2_000_000,
      );
    case "addLiquidity":
      // ActionRouter v3 fixes the SY-share typing bug — Add LP routes through
      // the router again (matches Remove LP). Approvals must be on SY-share
      // + PT toward the router, not the market.
      return exec(
        op.router,
        "addLiquidityProportional",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.syIn))
          .addUint256(toBN(op.ptIn))
          .addUint256(toBN(op.minLpOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        0,
        4_000_000,
      );
    case "removeLiquidity":
      return exec(
        op.router,
        "removeLiquidityProportional",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.lpIn))
          .addUint256(toBN(op.minSyOut))
          .addUint256(toBN(op.minPtOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        0,
        4_000_000,
      );
    case "zapHbarToPtMega":
      return exec(
        op.megaZap,
        "zapHbarToPt",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addAddress(op.sy)
          .addUint256(toBN(op.minPtOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        op.hbarIn + 5, // user input + 5 HBAR NPM fee
        15_000_000,
      );
    case "zapHbarToYtMega":
      return exec(
        op.megaZap,
        "zapHbarToYt",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addAddress(op.sy)
          .addUint256(toBN(op.minSyOutFromPtSale))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        op.hbarIn + 5,
        15_000_000,
      );
    case "zapHbarToLpMega":
      return exec(
        op.megaZap,
        "zapHbarToLp",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addAddress(op.sy)
          .addUint16(op.ptShareBps) // matches contract's uint16
          .addUint256(toBN(op.minLpOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        op.hbarIn + 5,
        15_000_000,
      );
    case "sellPtForHbar":
      // 8M gas — observed smoke used ~3M with ~30 child records out of 50.
      // Headroom for V3 tick crossings during volatile state.
      return exec(
        op.unzap,
        "sellPtForHbar",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.ptIn))
          .addUint256(toBN(op.minHbarOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        0,
        8_000_000,
      );
    case "unzapSy":
      return exec(
        op.unzap,
        "unzapSy",
        new ContractFunctionParameters()
          .addAddress(op.sy)
          .addUint256(toBN(op.sharesIn))
          .addUint256(toBN(op.minHbarOut))
          .addAddress(op.receiver),
        0,
        6_000_000,
      );
    case "sellLpForHbar":
      return exec(
        op.unzap,
        "sellLpForHbar",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.lpIn))
          .addUint256(toBN(op.minHbarOut))
          .addAddress(op.receiver)
          .addUint256(toBN(op.deadline)),
        0,
        10_000_000,
      );
  }
}

/* ─────────────────────────────────────────────────── Revert decoding */

/**
 * Common Hedera HTS response codes that surface as `Panic(uint256)`-shaped
 * reverts inside HTS-touching contracts. Sourced from
 * proto/ResponseCodeEnum.proto (codes 0..N) — only the ones the user can
 * actually do something about are listed here. The full list is huge; if
 * we hit an unknown code we render the numeric value verbatim.
 */
const HTS_CODES: Record<number, string> = {
  22: "Token transfer failed: insufficient token balance",
  178: "Token has been deleted",
  184: "Token not associated with your account — open HashPack and associate it (or the dApp should prompt you)",
  185: "Token has not been kyc'd for your account",
  186: "Account is frozen for this token",
  194: "Spender does not have enough allowance",
  226: "Token has expired",
  309: "Insufficient token balance",
};

interface MirrorTxResult {
  transactions: Array<{
    transaction_id: string;
    result: string;
  }>;
}

interface MirrorContractResult {
  error_message?: string;
  result?: string;
  status?: string;
}

/**
 * Given a Hedera transaction ID, fetches the contract result from Mirror
 * Node and decodes the revert reason into a human string. Returns null
 * if we can't decode anything useful — caller should fall back to the
 * original error.
 *
 * Mirror Node sometimes lags by 1-3 seconds after a tx finalizes, so
 * we retry a couple of times.
 */
async function decodeRevert(transactionId: string): Promise<string | null> {
  if (!transactionId) return null;
  // Tx ID comes as "0.0.X@SECS.NANOS" — Mirror Node also accepts that, but
  // its /transactions endpoint wants "0.0.X-SECS-NANOS". Normalize.
  const normalized = transactionId.replace("@", "-").replace(".", "-");
  const base = "https://mainnet-public.mirrornode.hedera.com/api/v1";

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const txRes = await fetch(`${base}/transactions/${normalized}`);
      if (!txRes.ok) continue;
      const data = (await txRes.json()) as MirrorTxResult;
      const tx = data.transactions?.[0];
      if (!tx) continue;

      const cRes = await fetch(`${base}/contracts/results/${normalized}`);
      if (!cRes.ok) continue;
      const c = (await cRes.json()) as MirrorContractResult;
      const msg = c.error_message;
      if (!msg) return tx.result ?? null;

      // Common shape: 0x24dd1bab + 32-byte arg, where the arg is the HTS
      // code as a uint256. Extract the last byte (codes < 256 fit in u8).
      const hex = msg.replace(/^0x/, "");
      if (hex.length >= 8 + 64) {
        const argHex = hex.slice(8); // strip selector
        // Trim leading zeros to recover the integer.
        const codeInt = parseInt(argHex.replace(/^0+/, "") || "0", 16);
        if (HTS_CODES[codeInt]) return HTS_CODES[codeInt];
        return `Contract reverted (HTS code ${codeInt}). Check HashScan: hashscan.io/mainnet/transaction/${transactionId}`;
      }
      // Standard Error(string) shape: 0x08c379a0 + abi-encoded string
      if (hex.startsWith("08c379a0")) {
        // Skip selector + 32-byte offset + 32-byte length → decode UTF-8
        try {
          const lenHex = hex.slice(8 + 64, 8 + 128);
          const len = parseInt(lenHex, 16);
          const dataHex = hex.slice(8 + 128, 8 + 128 + len * 2);
          const buf = new Uint8Array(len);
          for (let i = 0; i < len; i++) buf[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
          return new TextDecoder().decode(buf);
        } catch {
          /* fall through */
        }
      }
      return `Contract reverted (selector 0x${hex.slice(0, 8)}). HashScan: hashscan.io/mainnet/transaction/${transactionId}`;
    } catch {
      /* retry */
    }
  }
  return null;
}
