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

  const cid = (addr: `0x${string}`) => ContractId.fromEvmAddress(0, 0, addr);
  const exec = async (
    contractAddress: `0x${string}`,
    functionName: string,
    params: InstanceType<typeof ContractFunctionParameters>,
    payableHbar: number,
    gas: number,
  ): Promise<{ txHash: string }> => {
    const tx = new ContractExecuteTransaction()
      .setContractId(cid(contractAddress))
      .setGas(gas)
      .setFunction(functionName, params);
    if (payableHbar > 0) tx.setPayableAmount(new Hbar(payableHbar));
    if (nodeIds.length > 0) tx.setNodeAccountIds(nodeIds);
    await tx.freezeWithSigner(signer as never);
    const resp = await tx.executeWithSigner(signer as never);
    // Wait for receipt so callers can rely on the tx being finalized.
    await resp.getReceiptWithSigner(signer as never);
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
  }
}
