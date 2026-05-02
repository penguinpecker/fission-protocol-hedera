"use client";

import { useReadContracts } from "wagmi";
import { erc20Abi, marketAbi, syAbi } from "@/lib/abis";

export interface MarketDetail {
  sy: `0x${string}`;
  pt: `0x${string}`;
  yt: `0x${string}`;
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
          { abi: marketAbi, address: market, functionName: "expiry" } as const,
          { abi: marketAbi, address: market, functionName: "scalarRoot" } as const,
          { abi: marketAbi, address: market, functionName: "totalSy" } as const,
          { abi: marketAbi, address: market, functionName: "totalPt" } as const,
          { abi: marketAbi, address: market, functionName: "lastLnImpliedRate" } as const,
          { abi: marketAbi, address: market, functionName: "totalSupply" } as const,
          { abi: marketAbi, address: market, functionName: "globalIndex" } as const,
        ]
      : [],
    query: { enabled: !!market },
    allowFailure: false,
  });

  const syAddr = marketRead.data?.[0] as `0x${string}` | undefined;
  const syRead = useReadContracts({
    contracts: syAddr
      ? [
          { abi: syAbi, address: syAddr, functionName: "name" } as const,
          { abi: syAbi, address: syAddr, functionName: "decimals" } as const,
          { abi: syAbi, address: syAddr, functionName: "exchangeRate" } as const,
        ]
      : [],
    query: { enabled: !!syAddr },
    allowFailure: false,
  });

  if (!marketRead.data || !syRead.data) {
    return { data: undefined, isLoading: marketRead.isLoading || syRead.isLoading };
  }

  const md = marketRead.data;
  const sd = syRead.data;
  const detail: MarketDetail = {
    sy: md[0] as `0x${string}`,
    pt: md[1] as `0x${string}`,
    yt: md[2] as `0x${string}`,
    expiry: md[3] as bigint,
    scalarRoot: md[4] as bigint,
    totalSy: md[5] as bigint,
    totalPt: md[6] as bigint,
    lastLnImpliedRate: md[7] as bigint,
    lpSupply: md[8] as bigint,
    globalIndex: md[9] as bigint,
    syName: sd[0] as string,
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
  const reads = market && detail && user
    ? [
        { abi: erc20Abi, address: detail.sy, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: detail.pt, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: detail.yt, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: market, functionName: "balanceOf", args: [user] } as const,
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
