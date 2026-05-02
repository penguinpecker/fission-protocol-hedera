import type { Address, PublicClient, WalletClient } from "viem";
import { syReadAbi, syWriteAbi } from "./abi.ts";

export interface PostResult {
  posted: boolean;
  reason?: string;
  txHash?: `0x${string}`;
  oldRate?: bigint;
  newRate: bigint;
  deltaBps?: number;
}

/**
 * Read current SY rate, decide whether the new rate should be posted, and post it
 * if so. The on-chain contract enforces interval and bps caps strictly; this client
 * mirror is defence in depth — a misconfigured keeper never burns gas on a tx that
 * would revert.
 */
export async function postIfDue(
  publicClient: PublicClient,
  walletClient: WalletClient,
  sy: Address,
  newRate: bigint,
  maxDeltaBps: number,
): Promise<PostResult> {
  const paused = await publicClient.readContract({
    address: sy,
    abi: syReadAbi,
    functionName: "paused",
  });
  if (paused) return { posted: false, reason: "sy paused", newRate };

  const count = await publicClient.readContract({
    address: sy,
    abi: syReadAbi,
    functionName: "count",
  });

  let oldRate: bigint | undefined;
  let deltaBps: number | undefined;

  if (count > 0n) {
    oldRate = await publicClient.readContract({
      address: sy,
      abi: syReadAbi,
      functionName: "exchangeRate",
    });
    deltaBps = absDeltaBps(oldRate, newRate);
    if (deltaBps > maxDeltaBps) {
      return {
        posted: false,
        reason: `delta ${deltaBps}bps > cap ${maxDeltaBps}`,
        oldRate,
        newRate,
        deltaBps,
      };
    }
    if (deltaBps === 0) {
      return { posted: false, reason: "no change", oldRate, newRate, deltaBps };
    }
  }

  const account = walletClient.account;
  if (!account) throw new Error("wallet client has no account");

  const hash = await walletClient.writeContract({
    chain: walletClient.chain ?? null,
    account,
    address: sy,
    abi: syWriteAbi,
    functionName: "postRate",
    args: [newRate],
  });

  await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { posted: true, oldRate, newRate, deltaBps, txHash: hash };
}

export function absDeltaBps(a: bigint, b: bigint): number {
  if (a === b) return 0;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return Number(((hi - lo) * 10_000n) / hi);
}
