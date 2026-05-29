"use client";

import { useEffect, useMemo, useState } from "react";
import { useReadContracts } from "wagmi";
import { erc20Abi, lensAbi, marketAbi, syAbi } from "@/lib/abis";
import { ADDRESSES, USDC_DECIMALS, WHBAR_DECIMALS } from "@/lib/addresses";
import { useHbarUsd, useSyValueUsd } from "@/hooks/useSyValueUsd";

const MIRROR_BASE = "https://mainnet-public.mirrornode.hedera.com/api/v1";

/**
 * REALUSE-02: detect an Ed25519 "long-zero" EVM address. ECDSA accounts get a
 * real keccak-derived evm_address (resolved from Mirror in provider.tsx), but a
 * true Ed25519 account has NO alias, so the app keeps its deterministic
 * long-zero form (`0x` + accountNum, left-padded with zeros). The HTS facade
 * `balanceOf` precompile REVERTS with INVALID_ACCOUNT_ID for such an address,
 * so every on-chain balance read silently resolves to 0 and the profile/position
 * card render an all-zero state. We detect the long-zero shape (the account num
 * fits well under 8 bytes, so the top 12 bytes are all zero) and source balances
 * from Mirror Node instead, which works for Ed25519.
 */
function isLongZeroAddress(addr: `0x${string}`): boolean {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 40) return false;
  // Top 12 bytes (24 hex chars) must be zero; the low 8 bytes hold the account
  // num. A keccak-derived ECDSA alias is overwhelmingly unlikely to be all-zero
  // there. Guard against the literal zero address (not a real account).
  return hex.slice(0, 24) === "0".repeat(24) && hex.slice(24) !== "0".repeat(16);
}

/** Convert a long-zero EVM address (`0x000…NUM`) to a Hedera id (`0.0.NUM`). */
function longZeroToHederaId(addr: `0x${string}`): string {
  return `0.0.${BigInt(addr).toString()}`;
}

interface MirrorTokensResponse {
  tokens?: Array<{ token_id: string; balance: number }>;
  links?: { next?: string | null };
}

/**
 * REALUSE-02: fetch HTS balances for an Ed25519 (long-zero) account from Mirror
 * Node, since the facade `balanceOf` reverts for those keys. Returns a map of
 * `0.0.X` token id → raw balance, or null while loading / on a true ECDSA
 * account (where on-chain reads are used instead).
 */
function useEd25519Balances(
  user: `0x${string}` | undefined,
  enabled: boolean,
): { balances: Record<string, bigint> | null; isLoading: boolean } {
  const [balances, setBalances] = useState<Record<string, bigint> | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !user) {
      setBalances(null);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    const accountId = longZeroToHederaId(user);
    (async () => {
      const out: Record<string, bigint> = {};
      try {
        // Page through the account's token relationships. The protocol tokens
        // (PT/YT/LP/SY-share) live here regardless of key type.
        let next: string | null = `${MIRROR_BASE}/accounts/${accountId}/tokens?limit=100`;
        let guard = 0;
        while (next && guard < 10) {
          guard += 1;
          const r: Response = await fetch(next);
          if (!r.ok) break;
          const data = (await r.json()) as MirrorTokensResponse;
          for (const t of data.tokens ?? []) {
            out[t.token_id] = BigInt(t.balance ?? 0);
          }
          const link = data.links?.next;
          next = link ? `${MIRROR_BASE.replace(/\/api\/v1$/, "")}${link}` : null;
        }
        if (!cancelled) setBalances(out);
      } catch {
        if (!cancelled) setBalances({});
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, user]);

  return { balances, isLoading };
}

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
  //
  // F7: the deployed rewards market has NO previewYield() (it reverts with empty
  // data), so the old read returned 0 everywhere. There are actually TWO reward
  // streams to surface:
  //   (a) market.previewRewards(user) → (usdc 6dec, whbar 8dec): the V3-LP
  //       SY-yield stream (currently non-zero on-chain).
  //   (b) Lens.previewPendingPtAmm / previewPendingYtAmm (market, user): the
  //       AMM-fee split, denominated in SY-share units.
  // All reads use the F1-resolved `user` (real ECDSA evm alias from Mirror) so
  // the HTS facade balanceOf calls don't revert with INVALID_ACCOUNT_ID.
  // REALUSE-02: a true Ed25519 account uses its long-zero address (no real evm
  // alias exists), and the HTS facade `balanceOf` REVERTS for that — every
  // balance below would silently resolve to 0n. Detect it and source the
  // PT/YT/LP/SY balances from Mirror Node instead (works for Ed25519). The
  // contract reads still fire (reward previews allowFailure to 0n), but the
  // four token balances get overridden from mirror in the memo below.
  const isEd25519 = !!user && isLongZeroAddress(user);
  const { balances: mirrorBalances, isLoading: mirrorLoading } = useEd25519Balances(user, isEd25519);

  const lens = ADDRESSES.lens;
  const reads = market && detail && user
    ? [
        { abi: erc20Abi, address: detail.syShare, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: detail.pt, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: detail.yt, functionName: "balanceOf", args: [user] } as const,
        { abi: erc20Abi, address: detail.lp, functionName: "balanceOf", args: [user] } as const,
        { abi: marketAbi, address: market, functionName: "previewRewards", args: [user] } as const,
        { abi: lensAbi, address: lens, functionName: "previewPendingPtAmm", args: [market, user] } as const,
        { abi: lensAbi, address: lens, functionName: "previewPendingYtAmm", args: [market, user] } as const,
      ]
    : [];

  // allowFailure: true — an old account that never associated with one of the
  // HTS tokens may revert on balanceOf, and the reward views may revert on a
  // non-rewards market variant. Default missing fields to 0n.
  const result = useReadContracts({
    contracts: reads,
    query: { enabled: reads.length > 0 },
    allowFailure: true,
  });

  // Price inputs for the computed USD value. Both share the module-scope
  // CoinGecko cache; safe to call unconditionally (hooks order is stable).
  const hbarUsd = useHbarUsd();
  const { usdPerShare } = useSyValueUsd(detail?.sy);

  // Memoize for stable object identity across renders — consumers list
  // `position` in useEffect deps and would otherwise refire infinitely.
  const data = useMemo(() => {
    // REALUSE-02: for an Ed25519 account, the on-chain facade reads above are
    // useless (they revert → 0n). Hold rendering until the mirror-sourced
    // balances land, then map token-id → PT/YT/LP/SY. The reward fields stay
    // 0n (their contract reads also revert for Ed25519) — acceptable; the
    // balances are what gate Redeem/Sell on the profile + position card.
    if (isEd25519) {
      if (!detail || !mirrorBalances) return undefined;
      const bal = (tokenAddr: `0x${string}`): bigint => {
        try {
          return mirrorBalances[longZeroToHederaId(tokenAddr)] ?? 0n;
        } catch {
          return 0n;
        }
      };
      return {
        sy: bal(detail.syShare),
        pt: bal(detail.pt),
        yt: bal(detail.yt),
        lp: bal(detail.lp),
        claimableYield: 0n,
        unclaimedRewardsRaw: { usdc: 0n, whbar: 0n, pendingPtAmm: 0n, pendingYtAmm: 0n },
        unclaimedRewardsUsd: 0,
      };
    }

    if (!result.data) return undefined;
    const r = result.data;
    const pluck = <T,>(entry: { status: "success"; result: T } | { status: "failure"; error: Error } | undefined): T | undefined =>
      entry?.status === "success" ? entry.result : undefined;

    // previewRewards returns a 2-tuple [usdc, whbar].
    const rewards = pluck<readonly [bigint, bigint]>(r[4] as never);
    const usdc = rewards?.[0] ?? 0n;
    const whbar = rewards?.[1] ?? 0n;
    const pendingPtAmm = pluck<bigint>(r[5] as never) ?? 0n;
    const pendingYtAmm = pluck<bigint>(r[6] as never) ?? 0n;

    const unclaimedRewardsRaw = { usdc, whbar, pendingPtAmm, pendingYtAmm };

    // USD valuation: USDC (6dec) at $1, WHBAR (8dec) at HBAR price, and the
    // AMM pending (SY-share units) valued via usdPerShare like any other SY.
    // undefined price inputs contribute 0 to the sum (the raw fields still
    // expose the underlying amounts for callers that prefer a raw display).
    const usdcUsd = Number(usdc) / 10 ** USDC_DECIMALS;
    const whbarUsd = hbarUsd !== undefined ? (Number(whbar) / 10 ** WHBAR_DECIMALS) * hbarUsd : 0;
    const ammPendingSy = Number(pendingPtAmm) + Number(pendingYtAmm);
    const ammPendingUsd = usdPerShare !== undefined ? ammPendingSy * usdPerShare : 0;
    const unclaimedRewardsUsd = usdcUsd + whbarUsd + ammPendingUsd;

    return {
      sy: (pluck<bigint>(r[0] as never) ?? 0n),
      pt: (pluck<bigint>(r[1] as never) ?? 0n),
      yt: (pluck<bigint>(r[2] as never) ?? 0n),
      lp: (pluck<bigint>(r[3] as never) ?? 0n),
      // Back-compat field kept for existing display logic (profile /
      // MarketPositionCard value it via usdPerShare). It now reflects the real
      // AMM-fee pending (SY-share units) instead of the always-0 previewYield.
      claimableYield: pendingPtAmm + pendingYtAmm,
      // F7 explicit fields — read by the profile page (exact names required).
      unclaimedRewardsRaw,
      unclaimedRewardsUsd,
    };
  }, [result.data, hbarUsd, usdPerShare, isEd25519, mirrorBalances, detail]);

  if (!data) {
    return {
      data: undefined,
      isLoading: isEd25519 ? mirrorLoading || mirrorBalances === null : result.isLoading,
    };
  }
  return { data, isLoading: false };
}
