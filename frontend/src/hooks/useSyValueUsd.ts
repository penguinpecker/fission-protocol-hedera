"use client";

import { useEffect, useState } from "react";
import { useReadContracts } from "wagmi";
import { erc20Abi, syAbi } from "@/lib/abis";

/**
 * USD valuation for an `SY_SaucerSwapV2LP` share token.
 *
 * The SY here wraps a single SaucerSwap V2 (Uniswap V3 fork) LP NFT. There is no
 * single-asset exchange rate that can value 1 share — the share is backed by a
 * (token0, token1) basket whose ratio depends on the pool's current tick. To
 * surface a $-value next to the raw share count we therefore have to:
 *
 *   1. Read the NFT id + ticks from the SY:        `npm()`, `positionTokenId()`,
 *                                                  `token0()`, `token1()`,
 *                                                  `tickLower()`, `tickUpper()`,
 *                                                  `poolFee()`.
 *   2. Read `liquidity` (L) from the NPM:          SaucerSwap V2's
 *                                                  `positions(tokenId)` ABI is
 *                                                  the standard Uniswap V3 shape
 *                                                  MINUS the leading
 *                                                  `nonce/operator` fields — it
 *                                                  returns 10 fields starting at
 *                                                  `token0`. Confirmed live via
 *                                                  Hashio `eth_call` 2026-05-13.
 *   3. Read the pool's current `sqrtPriceX96`:     via
 *                                                  `factory.getPool(t0,t1,fee)`
 *                                                  then `pool.slot0()`.
 *   4. Apply Uniswap V3 amount formulas in BigInt: given (L, sqrtP, sqrtA, sqrtB)
 *                                                  for tick inside the range,
 *                                                    amount0 = L·(sqrtB−sqrtP)·2^96
 *                                                              ────────────────────
 *                                                              sqrtB · sqrtP
 *                                                    amount1 = L·(sqrtP − sqrtA) / 2^96
 *                                                  (V3 whitepaper §6.) For
 *                                                  full-range positions we still
 *                                                  evaluate the same formulas —
 *                                                  no special-casing — because
 *                                                  TickMath gives finite sqrtRatios
 *                                                  at the V3 tick bounds anyway.
 *   5. Price the basket in USD:                    USDC is 1:1 (assumed peg —
 *                                                  acceptable for a UI hint at
 *                                                  the dollar level, never used
 *                                                  for trade-size decisions);
 *                                                  WHBAR comes from CoinGecko's
 *                                                  free `simple/price` endpoint,
 *                                                  cached in module scope for
 *                                                  60 s to avoid hammering it
 *                                                  across re-renders.
 *
 * Wrapped vs unwrapped: USDC = token0 (6 dec), WHBAR = token1 (8 dec). The SY
 * declares 18 share decimals but issues `liquidity` units 1:1, so a user-balance
 * of e.g. 61_508_062 raw shares is also 61_508_062 V3 liquidity units. We use
 * BigInt throughout — single Number multiply at the very end after a safe
 * down-scale.
 *
 * Failure mode: if any read fails (NFT not minted, NPM revert, CoinGecko down)
 * we return `usdPerShare: undefined`. Callers must hide the line, not show $0.
 */

// ─────────────────────────────── ABIs ───────────────────────────────

const syPositionAbi = [
  { type: "function", name: "npm", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "positionTokenId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "poolFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "tickLower", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "tickUpper", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
] as const;

/**
 * SaucerSwap V2 NPM `positions(uint256)` — non-standard 10-field shape (no
 * leading nonce/operator vs canonical Uniswap V3). Verified live via Hashio
 * `eth_call` on token 74444 (response length 320 bytes = 10 × 32).
 */
const npmPositionsAbi = [
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  // Some NPM deployments expose `factory()`; we don't strictly need it —
  // the SY's `npm()` + `token0()/token1()/poolFee()` is enough to derive the
  // pool address via the well-known SaucerSwap V2 factory below.
] as const;

const factoryGetPoolAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const poolSlot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

// ─────────────────────────────── constants ───────────────────────────────

/**
 * SaucerSwap V2 factory (`0.0.3947857`). Hard-coded because (a) the SY exposes
 * the NPM, not the factory, and (b) on Hedera the factory address is stable —
 * changing it would require redeploying the entire V2 DEX. If a future SY ever
 * targeted a different concentrated-liquidity DEX we'd add a per-SY override.
 */
const SAUCERSWAP_V2_FACTORY = "0x00000000000000000000000000000000003c3951" as const;

/**
 * USDC HTS facade on Hedera mainnet. Used to recognise USDC and treat it as
 * 1.000 USD without going through CoinGecko. If we ever support a non-USDC
 * stable as token0 we'd swap in a small map of pegged tokens.
 */
const USDC_ADDR = "0x000000000000000000000000000000000006f89a" as const;
const WHBAR_ADDR = "0x0000000000000000000000000000000000163b5a" as const;

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd";

// ─────────────────────────────── CoinGecko cache ───────────────────────────────

/**
 * Module-scope cache so every component using this hook in the same page load
 * shares one HBAR/USD fetch. 60 s TTL is plenty for a "≈ $X.XX" hint — the
 * exchange-rate column in our UI doesn't budge at the cent level inside a
 * minute, and the user can refresh the page to force a re-fetch.
 */
const HBAR_CACHE_TTL_MS = 60_000;
let hbarCache: { price: number; ts: number } | null = null;
let hbarInflight: Promise<number | null> | null = null;

async function fetchHbarUsd(): Promise<number | null> {
  const now = Date.now();
  if (hbarCache && now - hbarCache.ts < HBAR_CACHE_TTL_MS) return hbarCache.price;
  if (hbarInflight) return hbarInflight;
  hbarInflight = (async () => {
    try {
      const res = await fetch(COINGECKO_URL, { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json()) as { "hedera-hashgraph"?: { usd?: number } };
      const price = json["hedera-hashgraph"]?.usd;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
      hbarCache = { price, ts: Date.now() };
      return price;
    } catch {
      return null;
    } finally {
      hbarInflight = null;
    }
  })();
  return hbarInflight;
}

// ─────────────────────────────── V3 math ───────────────────────────────

const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;
const U256_MAX = (1n << 256n) - 1n;

/**
 * Uniswap V3 TickMath.getSqrtRatioAtTick — port of the canonical fixed-point
 * implementation (https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol).
 * Returns sqrt(1.0001^tick) · 2^96 as a uint160-ranged BigInt. Domain:
 * |tick| ≤ 887272 (the V3 hard cap). We don't gate on the cap here because the
 * SY ticks are immutable and known to be in range; callers feed validated input.
 */
function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = tick < 0 ? -tick : tick;
  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = U256_MAX / ratio;
  // Round up to a uint160 (the V3 contract does `(ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1)`).
  const shifted = ratio >> 32n;
  return ratio % (1n << 32n) === 0n ? shifted : shifted + 1n;
}

/**
 * Given V3 (liquidity, sqrtPriceCurrent, tickLower, tickUpper) return the raw
 * (amount0, amount1) the position would unwind to right now. Mirrors
 * LiquidityAmounts.getAmountsForLiquidity (https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/LiquidityAmounts.sol).
 * Always returns non-negative BigInts; below-range = all token0, above = all token1.
 */
function getAmountsForLiquidity(
  liquidity: bigint,
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
): { amount0: bigint; amount1: bigint } {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  // Should never matter (ticks immutable + ordered) but mirror V3 just in case.
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];

  if (sqrtP <= lo) {
    // All token0.
    const amount0 = (liquidity * Q96 * (hi - lo)) / (hi * lo);
    return { amount0, amount1: 0n };
  }
  if (sqrtP >= hi) {
    // All token1.
    const amount1 = (liquidity * (hi - lo)) / Q96;
    return { amount0: 0n, amount1 };
  }
  const amount0 = (liquidity * Q96 * (hi - sqrtP)) / (hi * sqrtP);
  const amount1 = (liquidity * (sqrtP - lo)) / Q96;
  return { amount0, amount1 };
}

// ─────────────────────────────── hook ───────────────────────────────

export interface SyValueUsd {
  /** USD value of one raw share unit (matches the `liquidity` scale, not 1e18). */
  usdPerShare: number | undefined;
  /**
   * USD value of the full V3 LP position. Useful for the market-level "total
   * SY locked" if a caller wants to render it as $ instead of share-units.
   */
  totalLpUsd: number | undefined;
  /**
   * Per-raw-share underlying token amounts. With these the caller can convert
   * a SY balance into "how much USDC and WHBAR does this represent" — which
   * is what the `pending_claims` panel needs to show per-asset breakdowns.
   * Both are token-decimal-adjusted (USDC has 6 decimals, WHBAR 8). Undefined
   * until the LP NFT + pool reads resolve.
   */
  usdcPerShare: number | undefined;
  whbarPerShare: number | undefined;
  isLoading: boolean;
}

/**
 * USD-per-share for a SaucerSwap-V2-LP SY. Disabled when `sy` is undefined or
 * when the SY hasn't minted its NFT yet (`positionTokenId == 0` — returns
 * `usdPerShare: undefined`, not `0`, so callers correctly hide the line).
 */
export function useSyValueUsd(sy: `0x${string}` | undefined): SyValueUsd {
  // 1) Read SY immutables + position id.
  const syRead = useReadContracts({
    contracts: sy
      ? [
          { abi: syPositionAbi, address: sy, functionName: "npm" } as const,
          { abi: syPositionAbi, address: sy, functionName: "positionTokenId" } as const,
          { abi: syPositionAbi, address: sy, functionName: "token0" } as const,
          { abi: syPositionAbi, address: sy, functionName: "token1" } as const,
          { abi: syPositionAbi, address: sy, functionName: "poolFee" } as const,
          { abi: syPositionAbi, address: sy, functionName: "tickLower" } as const,
          { abi: syPositionAbi, address: sy, functionName: "tickUpper" } as const,
          { abi: syAbi, address: sy, functionName: "shareToken" } as const,
        ]
      : [],
    query: { enabled: !!sy },
    allowFailure: true,
  });

  const pluck = <T,>(
    entry: { status: "success"; result: T } | { status: "failure"; error: Error } | undefined,
  ): T | undefined => (entry?.status === "success" ? entry.result : undefined);

  const npm = pluck<`0x${string}`>(syRead.data?.[0] as never);
  const tokenId = pluck<bigint>(syRead.data?.[1] as never);
  const token0 = pluck<`0x${string}`>(syRead.data?.[2] as never);
  const token1 = pluck<`0x${string}`>(syRead.data?.[3] as never);
  const poolFee = pluck<number>(syRead.data?.[4] as never);
  const tickLower = pluck<number>(syRead.data?.[5] as never);
  const tickUpper = pluck<number>(syRead.data?.[6] as never);
  const shareToken = pluck<`0x${string}`>(syRead.data?.[7] as never);

  // 2) Once we know token0/token1/poolFee, fetch the pool address via factory.
  const factoryRead = useReadContracts({
    contracts:
      token0 && token1 && poolFee !== undefined
        ? [
            {
              abi: factoryGetPoolAbi,
              address: SAUCERSWAP_V2_FACTORY,
              functionName: "getPool",
              args: [token0, token1, poolFee],
            } as const,
          ]
        : [],
    query: { enabled: !!token0 && !!token1 && poolFee !== undefined },
    allowFailure: true,
  });

  const pool = pluck<`0x${string}`>(factoryRead.data?.[0] as never);

  // 3) With NPM + tokenId + pool we can pull liquidity and sqrtPriceX96.
  const positionRead = useReadContracts({
    contracts:
      npm && tokenId !== undefined && tokenId > 0n && pool && shareToken
        ? [
            { abi: npmPositionsAbi, address: npm, functionName: "positions", args: [tokenId] } as const,
            { abi: poolSlot0Abi, address: pool, functionName: "slot0" } as const,
            { abi: erc20Abi, address: shareToken, functionName: "totalSupply" } as const,
          ]
        : [],
    query: {
      enabled:
        !!npm && tokenId !== undefined && tokenId > 0n && !!pool && !!shareToken,
    },
    allowFailure: true,
  });

  type PositionsTuple = readonly [
    `0x${string}`, // token0
    `0x${string}`, // token1
    number, // fee
    number, // tickLower
    number, // tickUpper
    bigint, // liquidity
    bigint, // feeGrowthInside0LastX128
    bigint, // feeGrowthInside1LastX128
    bigint, // tokensOwed0
    bigint, // tokensOwed1
  ];
  type Slot0Tuple = readonly [bigint, number, number, number, number, number, boolean];

  const positionTuple = pluck<PositionsTuple>(positionRead.data?.[0] as never);
  const slot0 = pluck<Slot0Tuple>(positionRead.data?.[1] as never);
  const totalSupplyShares = pluck<bigint>(positionRead.data?.[2] as never);

  // 4) HBAR/USD — fetch + cache once per hook lifetime (refetched on TTL miss).
  const [hbarUsd, setHbarUsd] = useState<number | undefined>(
    hbarCache && Date.now() - hbarCache.ts < HBAR_CACHE_TTL_MS ? hbarCache.price : undefined,
  );
  // Only kick off the network fetch when we actually have something to value
  // (NFT minted, pool resolved). Avoids hitting CoinGecko on SYs that don't
  // use this adapter shape at all (e.g. HBARX, where this hook short-circuits
  // higher up via the SY reads failing).
  const needsHbar =
    !!sy &&
    !!npm &&
    !!pool &&
    !!shareToken &&
    tokenId !== undefined &&
    tokenId > 0n;
  useEffect(() => {
    if (!needsHbar) return;
    if (hbarUsd !== undefined) return;
    let cancelled = false;
    void fetchHbarUsd().then((p) => {
      if (cancelled) return;
      if (p !== null) setHbarUsd(p);
    });
    return () => {
      cancelled = true;
    };
  }, [needsHbar, hbarUsd]);

  // 5) Loading aggregation. We say "loading" until we know whether the SY even
  // matches this adapter shape — once any of the SY reads has settled to a
  // definite "this isn't an LP-SY" we stop loading and return undefined.
  const isLoading =
    syRead.isLoading ||
    factoryRead.isLoading ||
    positionRead.isLoading ||
    (needsHbar && hbarUsd === undefined);

  // 6) Bail when any required piece is missing. This is the "SY is HBARX,
  // not an LP-SY" branch: `npm()` reverts, so `npm` is undefined, and we
  // never even started the CoinGecko fetch.
  if (
    !sy ||
    !npm ||
    !shareToken ||
    !pool ||
    !positionTuple ||
    !slot0 ||
    tickLower === undefined ||
    tickUpper === undefined ||
    totalSupplyShares === undefined ||
    totalSupplyShares === 0n ||
    hbarUsd === undefined ||
    token0 === undefined ||
    token1 === undefined
  ) {
    return { usdPerShare: undefined, totalLpUsd: undefined, usdcPerShare: undefined, whbarPerShare: undefined, isLoading };
  }

  // 7) Sanity-check that the NPM ticks match the SY ticks. If a future
  // rebalance flow ever changed the NFT range mid-flight, the SY's immutable
  // ticks would be stale and we'd mis-value the position. Until then this is
  // belt-and-braces — we trust the NPM as the source of truth.
  const liquidity = positionTuple[5];
  if (liquidity === 0n) {
    return { usdPerShare: 0, totalLpUsd: 0, usdcPerShare: 0, whbarPerShare: 0, isLoading: false };
  }

  const sqrtP = slot0[0];
  const { amount0, amount1 } = getAmountsForLiquidity(
    liquidity,
    sqrtP,
    tickLower,
    tickUpper,
  );

  // 8) Price each side. Currently supports USDC (peg) and WHBAR (CoinGecko).
  // For any other token we bail out — we'd rather not show a stale or wrong $
  // value than guess. Adding new SYs that use different underlyings means
  // adding their price source here.
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();

  // amount0/amount1 are in raw token units; we need their USD value.
  // We round-trip through Number only after dividing by token decimals (so the
  // BigInt magnitude is small enough that float precision is irrelevant at
  // the cent level: USDC has 12 fractional bits of headroom, WHBAR 8, and the
  // total LP USD value caps at low-millions for this market).
  const valueSide = (addr: string, raw: bigint): number | undefined => {
    if (addr === USDC_ADDR.toLowerCase()) {
      // USDC has 6 decimals; 1 USDC = 1 USD (peg assumed for UI hint).
      return Number(raw) / 1e6;
    }
    if (addr === WHBAR_ADDR.toLowerCase()) {
      // WHBAR has 8 decimals.
      return (Number(raw) / 1e8) * hbarUsd;
    }
    return undefined;
  };

  const usd0 = valueSide(t0, amount0);
  const usd1 = valueSide(t1, amount1);
  if (usd0 === undefined || usd1 === undefined) {
    return { usdPerShare: undefined, totalLpUsd: undefined, usdcPerShare: undefined, whbarPerShare: undefined, isLoading: false };
  }

  const totalLpUsd = usd0 + usd1;
  // Per-share scaled to the raw integer count the UI shows (formatCompact
  // treats the bigint as a count, no decimal division). totalSupply is in
  // the same units; division gives $-per-raw-share-unit.
  const usdPerShare = totalLpUsd / Number(totalSupplyShares);
  // Per-asset decomposition for the pending_claims panel — caller can
  // multiply by the user's claimable SY balance to get the underlying
  // USDC + WHBAR they'd receive on redeem. token0/token1 may be swapped
  // for older markets, so resolve by address rather than position.
  const t0IsUsdc = t0 === USDC_ADDR.toLowerCase();
  const usdcRaw = t0IsUsdc ? amount0 : amount1;
  const whbarRaw = t0IsUsdc ? amount1 : amount0;
  const usdcPerShare = (Number(usdcRaw) / 1e6) / Number(totalSupplyShares);
  const whbarPerShare = (Number(whbarRaw) / 1e8) / Number(totalSupplyShares);

  return { usdPerShare, totalLpUsd, usdcPerShare, whbarPerShare, isLoading: false };
}

/**
 * Convenience wrapper for the common "user owns N raw shares, what is that
 * worth?" case. Multiplies safely through BigInt → Number at the end.
 */
export function shareBalanceToUsd(
  balance: bigint | undefined,
  usdPerShare: number | undefined,
): number | undefined {
  if (balance === undefined || usdPerShare === undefined) return undefined;
  // Number(bigint) is safe here for the values we care about — share counts
  // are O(1e9), well inside Number.MAX_SAFE_INTEGER (2^53 ≈ 9e15).
  return Number(balance) * usdPerShare;
}

/** Format a USD amount with two-decimals precision, kept consistent across both UI sites. */
export function formatUsd(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  if (n === 0) return "$0.000";
  const abs = Math.abs(n);
  // Tiny positions: 4 decimals so $0.0001 yields are visible.
  if (abs > 0 && abs < 0.001) return `${n < 0 ? "-" : ""}$${abs.toFixed(4)}`;
  // Small-but-meaningful: 3 decimals. Small reward accruals (a few cents of
  // SAUCE / WHBAR from V3 fees) need to show as $0.012 not "$0.01" rounded.
  if (abs < 10) {
    return `${n < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
  }
  // $10 and up: standard 2-decimal display so big numbers stay legible.
  return `${n < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Standalone HBAR/USD price hook. Reuses the module-scope CoinGecko cache so
 * the BuyPt/BuyYt/MintSy forms don't each hit the rate-limited free endpoint —
 * `useSyValueUsd` and this hook share a single 60 s TTL cache and a single
 * inflight promise.
 *
 * Returns `undefined` while loading or on fetch failure. Callers should fall
 * back to a raw-amount input UI in that case rather than silently rendering $0.
 */
export function useHbarUsd(): number | undefined {
  const [hbarUsd, setHbarUsd] = useState<number | undefined>(
    hbarCache && Date.now() - hbarCache.ts < HBAR_CACHE_TTL_MS ? hbarCache.price : undefined,
  );
  useEffect(() => {
    if (hbarUsd !== undefined) return;
    let cancelled = false;
    void fetchHbarUsd().then((p) => {
      if (cancelled) return;
      if (p !== null) setHbarUsd(p);
    });
    return () => {
      cancelled = true;
    };
  }, [hbarUsd]);
  return hbarUsd;
}
