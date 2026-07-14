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
import { createPublicClient, parseEther } from "viem";
import { hederaMainnet } from "@/lib/chains";
import { hederaReadTransport } from "@/lib/rpc-client";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { useHederaWallet } from "./provider";
import {
  erc20WriteAbi,
  routerAbi,
  marketWriteAbi,
  syWriteAbi,
  fissionGatewayAbi,
  fissionPeripheryAbi,
} from "@/lib/abis-write";
import { ADDRESSES } from "@/lib/addresses";

export type WriteOp =
  /**
   * Generic Periphery call for the post-rebuild 2-tx forms. `functionName` and
   * `args` map directly to one of the 8 Periphery entry points; `value` only
   * needed for `zapHbarToSy`. Use this instead of the legacy MegaZap/Gateway
   * `kind`s — those route to ZERO addresses now.
   */
  | {
      kind: "writePeriphery";
      functionName:
        | "zapHbarToSy"
        | "buySyForPt"
        | "buySyForYt"
        | "buySyForLp"
        | "sellPtForSy"
        | "sellYtForSy"
        | "sellLpForSy"
        | "unzapSyToHbar";
      args: readonly unknown[];
      value?: bigint;
    }
  | { kind: "approveErc20"; token: `0x${string}`; spender: `0x${string}`; amount: bigint }
  /**
   * Set / revoke an operator on a market. Used by the profile / settings UI
   * for X-7 mitigation — users can flip off any Periphery they previously
   * approved as YT-sell operator.
   */
  | { kind: "marketSetOperator"; market: `0x${string}`; operator: `0x${string}`; approved: boolean }
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
  /**
   * Claim accrued AMM-fee share (PT-holder + YT-holder buckets, paid in
   * SY-share) from a FissionRewardsMarket. Used by the profile Claim buttons.
   */
  | { kind: "claimAmmRewards"; market: `0x${string}`; receiver: `0x${string}` }
  /**
   * Claim accrued SY yield rewards (reward tokens) from a FissionRewardsMarket.
   */
  | { kind: "claimRewards"; market: `0x${string}`; receiver: `0x${string}` }
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
        // Pre-flight: if the current signer's topic is no longer live (HashPack
        // deleted/re-paired the session), rebuild BEFORE we sign so we never
        // execute against a dead topic.
        if (!hedera.isSessionLive()) {
          await hedera.refreshConnector();
        }
        try {
          return await writeHedera(op, hedera.getConnector(), hedera.accountId ?? undefined);
        } catch (e) {
          // Self-heal the stale-session error class (mirrors the connect + SIWE
          // self-heal): rebuild the connector to mint a fresh signer bound to
          // the live session, then retry ONCE. User rejections don't match.
          const msg = e instanceof Error ? e.message : String(e);
          if (STALE_SESSION.test(msg)) {
            await hedera.refreshConnector();
            return writeHedera(op, hedera.getConnector(), hedera.accountId ?? undefined);
          }
          throw e;
        }
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
        type HederaSigner = {
          signMessage(params: { signerAccountId: string; message: string }): Promise<{ signatureMap: string }>;
        };
        // ONE prompt only. HashPack's dapp-browser churns the WC session on open,
        // so make the session STABLE *before* prompting: if it's not live, refresh
        // once (which in-iframe silently re-pairs) and WAIT for the fresh session
        // to register live, then sign a SINGLE time. The old code prompted, and on
        // a stale-session error refreshed + re-prompted — so HashPack asked the
        // user to approve the signature twice. We no longer re-prompt after the
        // session is confirmed live; a genuine death throws and the user re-taps.
        if (!hedera.isSessionLive()) {
          await hedera.refreshConnector();
          for (let i = 0; i < 15 && !hedera.isSessionLive(); i++) {
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        const connector = hedera.getConnector() as null | HederaSigner;
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

/**
 * Stale-session error class raised when a DAppSigner's WC topic was deleted /
 * re-paired by the wallet (HashPack dapp-browser does this on open). Matches
 * the tx path ('Record was recently deleted - session: <topic>') and the WC
 * client-not-ready cases. Deliberately does NOT match 'User rejected' so we
 * never re-prompt a user who declined.
 */
const STALE_SESSION =
  /record was recently deleted|no matching key|session topic|not initialized|missing or invalid/i;

/* ───────────────────────────────────────────────────────── EVM path */

/**
 * Read-only viem public client used purely to await tx finality in EVM mode.
 * `writeContractAsync` (wagmi) resolves the moment the tx is SUBMITTED, not
 * when it's mined — multi-step flows (setOperator→sell, approve→action) then
 * fire the dependent tx against stale chain state (isOperator=false,
 * allowance=0) and revert (NotAuthorized / AMOUNT_EXCEEDS_ALLOWANCE).
 *
 * SELL-EVM-RECEIPT-RACE fix: after every submit we block on
 * waitForTransactionReceipt so the hash we return is final — exactly what the
 * Hedera path already does via getReceiptWithSigner. Every form's
 * dependent-tx sequencing (Buy/Sell/LP) gets correct ordering for free.
 */
let _evmPublicClient: ReturnType<typeof createPublicClient> | null = null;
function evmPublicClient() {
  if (!_evmPublicClient) {
    _evmPublicClient = createPublicClient({ chain: hederaMainnet, transport: hederaReadTransport() });
  }
  return _evmPublicClient;
}

/**
 * Submit the op via wagmi, then await its receipt before returning, so the
 * returned hash is mined/final. Mirrors the Hedera path's receipt wait.
 */
async function writeEvm(
  op: WriteOp,
  writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"],
): Promise<{ txHash: string }> {
  const { txHash } = await writeEvmSubmit(op, writeContractAsync);
  // Wait for finality. If the hash isn't an EVM tx hash for some reason
  // (shouldn't happen on the wagmi path), skip the wait rather than throw.
  if (txHash.startsWith("0x")) {
    await evmPublicClient().waitForTransactionReceipt({ hash: txHash as `0x${string}` });
  }
  return { txHash };
}

async function writeEvmSubmit(
  op: WriteOp,
  writeContractAsync: ReturnType<typeof useWriteContract>["writeContractAsync"],
): Promise<{ txHash: string }> {
  switch (op.kind) {
    case "writePeriphery":
      return {
        txHash: await writeContractAsync({
          abi: fissionPeripheryAbi,
          address: ADDRESSES.periphery,
          functionName: op.functionName,
          // viem expects readonly any[] — the union of signatures across the 8
          // Periphery entry points doesn't typecheck without an explicit cast.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          args: op.args as any,
          value: op.value,
        }),
      };
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
    case "marketSetOperator":
      return {
        txHash: await writeContractAsync({
          abi: [{
            type: "function", name: "setOperator", stateMutability: "nonpayable",
            inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }],
            outputs: [],
          }] as const,
          address: op.market,
          functionName: "setOperator",
          args: [op.operator, op.approved],
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
      // Post-rebuild (2026-05-27): routed through the new FissionPeriphery.
      // Periphery.zapHbarToSy(market, receiver, deadline) — payable, msg.value
      // is full HBAR amount (Periphery reserves v3NpmFeeBudget internally).
      return {
        txHash: await writeContractAsync({
          abi: fissionPeripheryAbi,
          address: ADDRESSES.periphery,
          functionName: "zapHbarToSy",
          args: [ADDRESSES.market, op.receiver, 0n],
          value: parseEther(String(op.hbarIn)),
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
    case "claimAmmRewards":
      return {
        txHash: await writeContractAsync({
          abi: marketWriteAbi,
          address: op.market,
          functionName: "claimAmmRewards",
          args: [op.receiver],
        }),
      };
    case "claimRewards":
      return {
        txHash: await writeContractAsync({
          abi: marketWriteAbi,
          address: op.market,
          functionName: "claimRewards",
          args: [op.receiver],
        }),
      };
    case "addLiquidity":
      // Post-rebuild: route directly to the market. The new Periphery doesn't
      // expose a addLiquidityProportional helper; the market's own addLiquidity
      // does transferFrom from msg.sender, so user must approve SY+PT to the
      // MARKET (not the Periphery) for this path.
      return {
        txHash: await writeContractAsync({
          abi: marketWriteAbi,
          address: op.market,
          functionName: "addLiquidity",
          args: [op.syIn, op.ptIn, op.minLpOut, op.receiver],
        }),
      };
    case "removeLiquidity":
      return {
        txHash: await writeContractAsync({
          abi: marketWriteAbi,
          address: op.market,
          functionName: "removeLiquidity",
          args: [op.lpIn, op.minSyOut, op.minPtOut, op.receiver],
        }),
      };
    // All HBAR-in / *ForHbar-out paths route through FissionGateway v2.
    // The op fields keep their original names for backward compat; the
    // unused ones (op.megaZap, op.unzap, op.sy where it was the share
    // token, op.receiver) are silently ignored — the gateway resolves
    // everything from the market address internally and delivers to msg.sender.
    case "zapHbarToPtMega":
      return {
        txHash: await writeContractAsync({
          abi: fissionGatewayAbi,
          address: ADDRESSES.fissionGateway,
          functionName: "zapHbarToPt",
          args: [op.market, op.minPtOut, op.deadline],
          value: parseEther(String(op.hbarIn + 5)), // +5 HBAR NPM buffer
        }),
      };
    case "zapHbarToYtMega":
      return {
        txHash: await writeContractAsync({
          abi: fissionGatewayAbi,
          address: ADDRESSES.fissionGateway,
          functionName: "zapHbarToYt",
          args: [op.market, op.minSyOutFromPtSale, op.deadline],
          value: parseEther(String(op.hbarIn + 5)),
        }),
      };
    case "zapHbarToLpMega":
      return {
        txHash: await writeContractAsync({
          abi: fissionGatewayAbi,
          address: ADDRESSES.fissionGateway,
          functionName: "zapHbarToLp",
          args: [op.market, op.ptShareBps, op.minLpOut, op.deadline],
          value: parseEther(String(op.hbarIn + 5)),
        }),
      };
    case "sellPtForHbar":
      return {
        txHash: await writeContractAsync({
          abi: fissionGatewayAbi,
          address: ADDRESSES.fissionGateway,
          functionName: "sellPtForHbar",
          args: [op.market, op.ptIn, op.minHbarOut, op.deadline],
        }),
      };
    case "unzapSy":
      // NOTE: `op.sy` is now expected to be the SY ADAPTER address (not the
      // share token). Form callers updated accordingly. Gateway derives the
      // HTS share token via adapter.shareToken() internally — the bug fix.
      return {
        txHash: await writeContractAsync({
          abi: fissionGatewayAbi,
          address: ADDRESSES.fissionGateway,
          functionName: "unzapSyForHbar",
          args: [op.sy, op.sharesIn, op.minHbarOut],
        }),
      };
    case "sellLpForHbar":
      return {
        txHash: await writeContractAsync({
          abi: fissionGatewayAbi,
          address: ADDRESSES.fissionGateway,
          functionName: "sellLpForHbar",
          args: [op.market, op.lpIn, op.minHbarOut, op.deadline],
        }),
      };
  }
}

/* ─────────────────────────────────────────────────────── Hedera path */

async function writeHedera(
  op: WriteOp,
  connectorMaybe: unknown,
  targetAccountId?: string,
): Promise<{ txHash: string }> {
  const connector = connectorMaybe as null | {
    signers: Array<{ getAccountId(): { toString(): string } }>;
  };
  if (!connector || !connector.signers?.length) {
    throw new Error("Hedera connector has no signer");
  }
  // Bind to the signer for the CURRENTLY-connected account, not blindly
  // signers[0]. After a HashPack in-wallet account switch the connector may hold
  // signers for several accounts; picking signers[0] could build the tx for the
  // wrong (old) account even though the UI shows the new one. Fall back to
  // signers[0] only if no exact match (single-account sessions).
  const signer =
    (targetAccountId
      ? connector.signers.find((s) => {
          try {
            return s.getAccountId().toString() === targetAccountId;
          } catch {
            return false;
          }
        })
      : undefined) ?? connector.signers[0];

  // Lazy-load the SDK so it doesn't sit in the initial bundle.
  const sdk = await import("@hashgraph/sdk");
  // AccountId is referenced only via `typeof AccountId` in InstanceType<>
  // below — TypeScript needs it in scope as a value but ESLint's
  // no-unused-vars doesn't track typeof-only uses.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    case "marketSetOperator":
      return exec(
        op.market,
        "setOperator",
        new ContractFunctionParameters()
          .addAddress(op.operator.replace(/^0x/, ""))
          .addBool(op.approved),
        0,
        1_000_000,
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
      // Post-rebuild 2026-05-27: routed through FissionPeriphery v3 with
      // signature zapHbarToSy(market, receiver, deadline). FissionGateway
      // was abandoned in the consolidation. msg.value is the full HBAR
      // amount — Periphery reserves its v3NpmFeeBudget internally so we
      // no longer add the +5 buffer.
      return exec(
        ADDRESSES.periphery,
        "zapHbarToSy",
        new ContractFunctionParameters()
          .addAddress(ADDRESSES.market.replace(/^0x/, ""))
          .addAddress(op.receiver.replace(/^0x/, ""))
          .addUint256(toBN(0n)),
        op.hbarIn,
        // Gas LIMIT, not usage: Hedera fronts limit×gasPrice up-front (refunds
        // unused). A real zap uses ~1.4M, so 15M reserved ~19 HBAR and blocked
        // small-balance buys with INSUFFICIENT_PAYER_BALANCE. 5M (~3.5× actual)
        // reserves ~6 HBAR — enough headroom, far lower balance bar.
        5_000_000,
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
        6_000_000, // was 14.5M — over-reserved HBAR; deposit uses ~1.4M
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
    case "claimAmmRewards":
      return exec(
        op.market,
        "claimAmmRewards",
        new ContractFunctionParameters().addAddress(op.receiver.replace(/^0x/, "")),
        0,
        2_500_000,
      );
    case "claimRewards":
      return exec(
        op.market,
        "claimRewards",
        new ContractFunctionParameters().addAddress(op.receiver.replace(/^0x/, "")),
        0,
        2_500_000,
      );
    case "addLiquidity":
      // Post-rebuild 2026-05-27: market.addLiquidity directly — Periphery v3
      // exposes buySyForLp (AMM-mediated) for the HBAR-in path but no
      // proportional helper for users who already hold SY+PT. User must
      // approve SY-share + PT toward the MARKET (not Periphery).
      return exec(
        op.market,
        "addLiquidity",
        new ContractFunctionParameters()
          .addUint256(toBN(op.syIn))
          .addUint256(toBN(op.ptIn))
          .addUint256(toBN(op.minLpOut))
          .addAddress(op.receiver.replace(/^0x/, "")),
        0,
        4_000_000,
      );
    case "removeLiquidity":
      // Post-rebuild 2026-05-27: market.removeLiquidity directly. Burns LP
      // from msg.sender (no allowance needed — internal _burnLp).
      return exec(
        op.market,
        "removeLiquidity",
        new ContractFunctionParameters()
          .addUint256(toBN(op.lpIn))
          .addUint256(toBN(op.minSyOut))
          .addUint256(toBN(op.minPtOut))
          .addAddress(op.receiver.replace(/^0x/, "")),
        0,
        4_000_000,
      );
    // All HBAR-in / *ForHbar-out paths route through FissionGateway v2.
    // The op.megaZap / op.unzap fields stay on WriteOp for backward compat
    // but are ignored — we always go through ADDRESSES.fissionGateway. The
    // gateway resolves token addresses internally from the market arg, so
    // op.sy / op.receiver are no longer passed to the contract (gateway
    // delivers to msg.sender).
    case "zapHbarToPtMega":
      return exec(
        ADDRESSES.fissionGateway,
        "zapHbarToPt",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.minPtOut))
          .addUint256(toBN(op.deadline)),
        op.hbarIn + 5, // +5 HBAR NPM buffer
        15_000_000,
      );
    case "zapHbarToYtMega":
      return exec(
        ADDRESSES.fissionGateway,
        "zapHbarToYt",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.minSyOutFromPtSale))
          .addUint256(toBN(op.deadline)),
        op.hbarIn + 5,
        15_000_000,
      );
    case "zapHbarToLpMega":
      return exec(
        ADDRESSES.fissionGateway,
        "zapHbarToLp",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint32(op.ptShareBps)  // SDK ContractFunctionParameters has addUint32 (no addUint16)
          .addUint256(toBN(op.minLpOut))
          .addUint256(toBN(op.deadline)),
        op.hbarIn + 5,
        15_000_000,
      );
    case "sellPtForHbar":
      return exec(
        ADDRESSES.fissionGateway,
        "sellPtForHbar",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.ptIn))
          .addUint256(toBN(op.minHbarOut))
          .addUint256(toBN(op.deadline)),
        0,
        8_000_000,
      );
    case "unzapSy":
      // NOTE: `op.sy` is now expected to be the SY ADAPTER address (not the
      // share token). The gateway derives the HTS share token via
      // `adapter.shareToken()` internally — this is the v1 bug fix.
      return exec(
        ADDRESSES.fissionGateway,
        "unzapSyForHbar",
        new ContractFunctionParameters()
          .addAddress(op.sy)
          .addUint256(toBN(op.sharesIn))
          .addUint256(toBN(op.minHbarOut)),
        0,
        6_000_000,
      );
    case "sellLpForHbar":
      return exec(
        ADDRESSES.fissionGateway,
        "sellLpForHbar",
        new ContractFunctionParameters()
          .addAddress(op.market)
          .addUint256(toBN(op.lpIn))
          .addUint256(toBN(op.minHbarOut))
          .addUint256(toBN(op.deadline)),
        0,
        10_000_000,
      );
    case "writePeriphery": {
      // Generic Periphery call for the post-rebuild 2-tx forms.
      // Encode args per function signature. Each entry maps the JS args[] to
      // the right ContractFunctionParameters builder calls. Falls back to
      // `unsupported` if a future form passes an unknown function name.
      const p = new ContractFunctionParameters();
      const fn = op.functionName;
      const a = op.args as unknown[];
      const valueHbar = op.value ? Number(op.value) / 1e18 : 0;
      // Helper: address arg cleanly (strips 0x).
      const addrArg = (v: unknown) => String(v).replace(/^0x/, "");
      switch (fn) {
        case "zapHbarToSy":
          p.addAddress(addrArg(a[0])).addAddress(addrArg(a[1])).addUint256(toBN(a[2] as bigint));
          return exec(ADDRESSES.periphery, fn, p, valueHbar, 5_000_000);
        case "buySyForPt":
        case "sellPtForSy":
        case "sellLpForSy":
        case "sellYtForSy":
          p.addAddress(addrArg(a[0])).addUint256(toBN(a[1] as bigint))
            .addUint256(toBN(a[2] as bigint)).addAddress(addrArg(a[3])).addUint256(toBN(a[4] as bigint));
          return exec(ADDRESSES.periphery, fn, p, 0, 6_000_000);
        case "buySyForYt":
          p.addAddress(addrArg(a[0])).addUint256(toBN(a[1] as bigint))
            .addUint256(toBN(a[2] as bigint)).addAddress(addrArg(a[3])).addUint256(toBN(a[4] as bigint));
          return exec(ADDRESSES.periphery, fn, p, 0, 6_000_000);
        case "buySyForLp":
          // (market, syIn, ptShareBps, ptOutFromSwap, minLpOut, receiver, deadline)
          p.addAddress(addrArg(a[0])).addUint256(toBN(a[1] as bigint)).addUint16(Number(a[2]))
            .addUint256(toBN(a[3] as bigint)).addUint256(toBN(a[4] as bigint))
            .addAddress(addrArg(a[5])).addUint256(toBN(a[6] as bigint));
          return exec(ADDRESSES.periphery, fn, p, 0, 6_000_000);
        case "unzapSyToHbar":
          p.addAddress(addrArg(a[0])).addUint256(toBN(a[1] as bigint))
            .addUint256(toBN(a[2] as bigint)).addUint256(toBN(a[3] as bigint));
          return exec(ADDRESSES.periphery, fn, p, 0, 6_000_000);
        default:
          throw new Error(`writePeriphery: unsupported function ${fn}`);
      }
    }
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
  // Tx ID comes as "0.0.X@SECS.NANOS" — Mirror Node's /transactions endpoint
  // wants "0.0.X-SECS-NANOS". The naive `.replace("@","-").replace(".","-")`
  // only fixes the FIRST dot, leaving the account id mangled
  // ("0-0.10495279-...") so Mirror 400s and HTS error decoding silently dies.
  // Split on "@": keep the account-id half verbatim (its dots are part of the
  // "0.0.X" id), and replace ONLY the dot in the "SECS.NANOS" timestamp half.
  const [acctId, ts] = transactionId.split("@");
  const normalized = ts ? `${acctId}-${ts.replace(".", "-")}` : acctId;
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
