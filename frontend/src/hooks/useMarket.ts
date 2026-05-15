"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { erc20Abi, marketAbi, syAbi } from "@/lib/abis";

/// Post-HTS-migration: PT/YT/LP/SY-shares are HTS-native fungibles. The market and SY
/// contracts expose `pt() / yt() / lp() / shareToken()` getters returning the HTS
/// token address. Use those addresses with `erc20Abi` for IERC20 reads.
export interface MarketDetail {
  sy: `0x${string}`;          // SY contract
  syShare: `0x${string}`;     // HTS share token (use for IERC20 reads)
  pt: `0x${string}`;          // HTS PT token
  yt: `0x${string}`;          // HTS YT token (frozen — AMM-only transfers)
  lp: `0x${string}`;          // HTS LP token
  expiry: bigint;
  scalarRoot: bigint;
  totalSy: bigint;
  totalPt: bigint;
  lastLnImpliedRate: bigint;
  lpSupply: bigint;
  globalIndex: bigint;
  syName: string;
  syDecimals: number;
  syExchangeRate: bigint;
}

/**
 * Fetch full per-market detail in two multicalls: one against the market itself, one
 * against the SY (after we know its address). Caller should drop the result if any
 * field is undefined.
 */
export function useMarketDetail(market: `0x${string}` | undefined) {
  // allowFailure: true so a missing function on one market variant (e.g.
  // FissionMarketRewards has no globalIndex() — it uses globalRewardIndex0/1
  // for the two reward streams) doesn't reject the entire batch and starve
  // the page of all market data.
  const marketRead = useReadContracts({
    contracts: market
      ? [
          { abi: marketAbi, address: market, functionName: "sy" } as const,
          { abi: marketAbi, address: market, functionName: "pt" } as const,
          { abi: marketAbi, address: market, functionName: "yt" } as const,
          { abi: marketAbi, address: market, functionName: "lp" } as const,
          { abi: marketAbi, address: market, functionName: "expiry" } as const,
          { abi: marketAbi, address: market, functionName: "scalarRoot" } as const,
          { abi: marketAbi, address: market, functionName: "totalSy" } as const,
          { abi: marketAbi, address: market, functionName: "totalPt" } as const,
          { abi: marketAbi, address: market, functionName: "lastLnImpliedRate" } as const,
          { abi: marketAbi, address: market, functionName: "globalIndex" } as const,
        ]
      : [],
    query: { enabled: !!market },
    allowFailure: true,
  });

  // Helper: pluck the result from a `{ status, result }` entry, returning
  // undefined on a "failure" (function-not-found / revert).
  const pluck = <T,>(entry: { status: "success"; result: T } | { status: "failure"; error: Error } | undefined): T | undefined =>
    entry?.status === "success" ? entry.result : undefined;

  const syAddr = pluck<`0x${string}`>(marketRead.data?.[0] as never);
  const lpAddr = pluck<`0x${string}`>(marketRead.data?.[3] as never);

  const syRead = useReadContracts({
    contracts: syAddr
      ? [
          { abi: syAbi, address: syAddr, functionName: "shareToken" } as const,
          { abi: syAbi, address: syAddr, functionName: "decimals" } as const,
          { abi: syAbi, address: syAddr, functionName: "exchangeRate" } as const,
        ]
      : [],
    query: { enabled: !!syAddr },
    allowFailure: true,
  });

  const syShare = pluck<`0x${string}`>(syRead.data?.[0] as never);

  const facadeRead = useReadContracts({
    contracts: syShare && lpAddr
      ? [
          { abi: erc20Abi, address: syShare, functionName: "name" } as const,
          { abi: erc20Abi, address: lpAddr, functionName: "totalSupply" } as const,
        ]
      : [],
    query: { enabled: !!syShare && !!lpAddr },
    allowFailure: true,
  });

  // Memoize the assembled detail so the returned object has stable identity
  // across renders when the underlying multicall data hasn't changed —
  // consumers depend on `detail` in useEffect deps, and a fresh object every
  // render would refire those effects (which earlier locked /profile).
  const detail = useMemo<MarketDetail | undefined>(() => {
    if (!marketRead.data || !syRead.data || !facadeRead.data) return undefined;
    const md = marketRead.data;
    const sd = syRead.data;
    const fd = facadeRead.data;
    const sy = pluck<`0x${string}`>(md[0] as never);
    const pt = pluck<`0x${string}`>(md[1] as never);
    const yt = pluck<`0x${string}`>(md[2] as never);
    const lp = pluck<`0x${string}`>(md[3] as never);
    const expiry = pluck<bigint>(md[4] as never);
    const totalSy = pluck<bigint>(md[6] as never);
    const totalPt = pluck<bigint>(md[7] as never);
    const lastLnImpliedRate = pluck<bigint>(md[8] as never);
    const syShareToken = pluck<`0x${string}`>(sd[0] as never);
    if (!sy || !pt || !yt || !lp || expiry === undefined || totalSy === undefined || totalPt === undefined || lastLnImpliedRate === undefined || !syShareToken) {
      return undefined;
    }
    return {
      sy,
      syShare: syShareToken,
      pt,
      yt,
      lp,
      expiry,
      scalarRoot: pluck<bigint>(md[5] as never) ?? 0n,
      totalSy,
      totalPt,
      lastLnImpliedRate,
      lpSupply: pluck<bigint>(fd[1] as never) ?? 0n,
      globalIndex: pluck<bigint>(md[9] as never) ?? 0n,
      syName: pluck<string>(fd[0] as never) ?? "—",
      syDecimals: Number(pluck<number>(sd[1] as never) ?? 18),
      syExchangeRate: pluck<bigint>(sd[2] as never) ?? 0n,
    };
  }, [marketRead.data, syRead.data, facadeRead.data]);

  if (!detail) {
    return {
      data: undefined,
      isLoading: marketRead.isLoading || syRead.isLoading || facadeRead.isLoading,
    };
  }
  return { data: detail, isLoading: false };
}

export function useUserPosition(
  market: `0x${string}` | undefined,
  detail: MarketDetail | undefined,
  user: `0x${string}` | undefined,
) {
  // All token-balance reads go through the HTS ERC-20 facade against the token
  // address (NOT the contract address — Market and SY are no longer ERC-20 themselves).
  const reads = market && detail && user
    ? [
        { abi: erc20Abi, address: detail.syShare, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: detail.pt, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: detail.yt, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: detail.lp, functionName: "balanceOf", args: [user] } as const,
        { abi: marketAbi, address: market, functionName: "previewYield", args: [user] } as const,
      ]
    : [];

  // allowFailure: true — previewYield doesn't exist on the rewards market,
  // and an old account that never associated with one of the HTS tokens
  // may revert on balanceOf. Default missing fields to 0n.
  const result = useReadContracts({
    contracts: reads,
    query: { enabled: reads.length > 0 },
    allowFailure: true,
  });

  // Memoize for stable object identity across renders — consumers list
  // `position` in useEffect deps and would otherwise refire infinitely.
  const data = useMemo(() => {
    if (!result.data) return undefined;
    const r = result.data;
    const pluck = <T,>(entry: { status: "success"; result: T } | { status: "failure"; error: Error } | undefined): T | undefined =>
      entry?.status === "success" ? entry.result : undefined;
    return {
      sy: (pluck<bigint>(r[0] as never) ?? 0n),
      pt: (pluck<bigint>(r[1] as never) ?? 0n),
      yt: (pluck<bigint>(r[2] as never) ?? 0n),
      lp: (pluck<bigint>(r[3] as never) ?? 0n),
      claimableYield: (pluck<bigint>(r[4] as never) ?? 0n),
    };
  }, [result.data]);

  if (!data) return { data: undefined, isLoading: result.isLoading };
  return { data, isLoading: false };
}
