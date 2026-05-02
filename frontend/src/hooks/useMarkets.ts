"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { factoryAbi, marketAbi, syAbi } from "@/lib/abis";

const factoryDeployed = isDeployed(ADDRESSES.factory);

/** Per-market metadata + state read from chain. */
export interface MarketSummary {
  address: `0x${string}`;
  syAddress: `0x${string}`;
  expiry: bigint;
  totalSy: bigint;
  totalPt: bigint;
  lastLnImpliedRate: bigint;
  lpSupply: bigint;
  name: string;
  symbol: string;
  syName: string;
  syDecimals: number;
}

export function useMarketCount() {
  return useReadContract({
    abi: factoryAbi,
    address: ADDRESSES.factory,
    functionName: "marketCount",
    query: { enabled: factoryDeployed },
  });
}

export function useMarketAddresses(count: bigint | undefined) {
  return useReadContract({
    abi: factoryAbi,
    address: ADDRESSES.factory,
    functionName: "getMarkets",
    args: [0n, count ?? 0n],
    query: { enabled: factoryDeployed && count !== undefined && count > 0n },
  });
}

/**
 * Batched per-market read. Issues a multicall with 9 reads per market in one round trip.
 */
export function useMarketDetails(addresses: readonly `0x${string}`[] | undefined) {
  const contracts = (addresses ?? []).flatMap((addr) => [
    { abi: marketAbi, address: addr, functionName: "sy" } as const,
    { abi: marketAbi, address: addr, functionName: "expiry" } as const,
    { abi: marketAbi, address: addr, functionName: "totalSy" } as const,
    { abi: marketAbi, address: addr, functionName: "totalPt" } as const,
    { abi: marketAbi, address: addr, functionName: "lastLnImpliedRate" } as const,
    { abi: marketAbi, address: addr, functionName: "totalSupply" } as const,
    { abi: marketAbi, address: addr, functionName: "name" } as const,
    { abi: marketAbi, address: addr, functionName: "symbol" } as const,
  ]);

  return useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
    allowFailure: false,
  });
}

/**
 * Reads SY metadata for the given SY addresses (one multicall, 2 reads each).
 */
export function useSyMetadata(addresses: readonly `0x${string}`[] | undefined) {
  const contracts = (addresses ?? []).flatMap((addr) => [
    { abi: syAbi, address: addr, functionName: "name" } as const,
    { abi: syAbi, address: addr, functionName: "decimals" } as const,
  ]);

  return useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
    allowFailure: false,
  });
}

/**
 * Convert ln(impliedRate) to an annualized APY percentage.
 * lastLnImpliedRate is 1e18-scaled; APY = exp(x/1e18) − 1.
 */
export function impliedApyPct(lastLnImpliedRate: bigint): number {
  const x = Number(lastLnImpliedRate) / 1e18;
  if (!Number.isFinite(x)) return 0;
  return (Math.exp(x) - 1) * 100;
}

export function daysUntil(expiry: bigint): number {
  const seconds = Number(expiry) - Math.floor(Date.now() / 1000);
  return Math.max(0, Math.floor(seconds / 86400));
}

export function formatBigInt(v: bigint, decimals: number, sigDigits = 4): string {
  const div = 10n ** BigInt(decimals);
  const whole = v / div;
  const frac = v % div;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, sigDigits);
  if (frac === 0n) return whole.toString();
  return `${whole}.${fracStr.replace(/0+$/, "") || "0"}`;
}
