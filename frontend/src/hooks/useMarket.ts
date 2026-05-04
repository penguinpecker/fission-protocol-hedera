"use client";

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
    allowFailure: false,
  });

  const syAddr = marketRead.data?.[0] as `0x${string}` | undefined;
  const lpAddr = marketRead.data?.[3] as `0x${string}` | undefined;
  const syRead = useReadContracts({
    contracts: syAddr
      ? [
          { abi: syAbi, address: syAddr, functionName: "shareToken" } as const,
          { abi: syAbi, address: syAddr, functionName: "decimals" } as const,
          { abi: syAbi, address: syAddr, functionName: "exchangeRate" } as const,
        ]
      : [],
    query: { enabled: !!syAddr },
    allowFailure: false,
  });

  // syShare and lp are both HTS tokens — read name + totalSupply via the ERC-20 facade.
  const syShare = syRead.data?.[0] as `0x${string}` | undefined;
  const facadeRead = useReadContracts({
    contracts: syShare && lpAddr
      ? [
          { abi: erc20Abi, address: syShare, functionName: "name" } as const,
          { abi: erc20Abi, address: lpAddr, functionName: "totalSupply" } as const,
        ]
      : [],
    query: { enabled: !!syShare && !!lpAddr },
    allowFailure: false,
  });

  if (!marketRead.data || !syRead.data || !facadeRead.data) {
    return {
      data: undefined,
      isLoading: marketRead.isLoading || syRead.isLoading || facadeRead.isLoading,
    };
  }

  const md = marketRead.data;
  const sd = syRead.data;
  const fd = facadeRead.data;
  const detail: MarketDetail = {
    sy: md[0] as `0x${string}`,
    syShare: sd[0] as `0x${string}`,
    pt: md[1] as `0x${string}`,
    yt: md[2] as `0x${string}`,
    lp: md[3] as `0x${string}`,
    expiry: md[4] as bigint,
    scalarRoot: md[5] as bigint,
    totalSy: md[6] as bigint,
    totalPt: md[7] as bigint,
    lastLnImpliedRate: md[8] as bigint,
    lpSupply: fd[1] as bigint,
    globalIndex: md[9] as bigint,
    syName: fd[0] as string,
    syDecimals: Number(sd[1]),
    syExchangeRate: sd[2] as bigint,
  };
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

  const result = useReadContracts({
    contracts: reads,
    query: { enabled: reads.length > 0 },
    allowFailure: false,
  });

  if (!result.data) return { data: undefined, isLoading: result.isLoading };
  const r = result.data;
  return {
    data: {
      sy: r[0] as bigint,
      pt: r[1] as bigint,
      yt: r[2] as bigint,
      lp: r[3] as bigint,
      claimableYield: r[4] as bigint,
    },
    isLoading: false,
  };
}
