import type { Address, PublicClient } from "viem";
import { staderAbi } from "../abi.ts";

/**
 * Read HBARX exchange rate directly from Stader's on-chain contract.
 * Returns 1e18-scaled HBAR-per-HBARX. Throws if the contract is unreachable.
 */
export async function fetchStaderRate(client: PublicClient, staderContract: Address): Promise<bigint> {
  const rate = await client.readContract({
    address: staderContract,
    abi: staderAbi,
    functionName: "getExchangeRate",
  });
  if (rate === 0n) throw new Error("Stader returned zero rate");
  return rate;
}
