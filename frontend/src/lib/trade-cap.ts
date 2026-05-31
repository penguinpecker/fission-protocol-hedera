/**
 * trade-cap — live per-trade size-cap reader, shared by every HBAR-source buy
 * form (Buy PT / Buy YT / Add LP).
 *
 * BUY-CAP-01 (defense-in-depth). The periphery caps the SY going into an AMM
 * swap at `maxTradeBps`% of the market's `totalSy` and reverts
 * `TradeExceedsCap` above it. On the HBAR path a buy is two txs:
 *
 *   Tx1  zapHbarToSy   — IRREVERSIBLE, delivers SY-share to the user
 *   Tx2  buySyFor{Pt,Yt,Lp} — the capped swap
 *
 * The pre-zap guard each form shows is LINEAR (`hbar·hbarUsd/usdPerShare`), but
 * the zap is NON-linear (a fixed HBAR fee → SY/HBAR rises with size), so a zap
 * can deliver MORE SY than the cap. By Tx2 time Tx1 has already settled, so a
 * `TradeExceedsCap` revert would STRAND the zapped SY. The forms therefore
 * re-read the cap right before Tx2 and clamp `syIn` to it; the excess simply
 * stays in the user's wallet as a SY-share token (sellable / reusable) — never
 * stranded.
 *
 * This is a no-op in the normal price regime (the pre-zap guard keeps syIn well
 * under the cap); it only fires on the knife-edge where the linear estimate
 * undershoots the real post-zap SY. The −0.1% headroom absorbs any `totalSy`
 * drift between this read and the actual swap. Returns 0n when the cap can't be
 * read, in which case callers DON'T clamp (the pre-zap guard + the on-chain cap
 * still apply), so a transient RPC error can never block a legitimate trade.
 */
import { createPublicClient, http } from "viem";
import { hederaMainnet } from "@/lib/chains";
import { lensAbi, marketAbi } from "@/lib/abis";
import { ADDRESSES } from "@/lib/addresses";

let _client: ReturnType<typeof createPublicClient> | null = null;
function client() {
  if (!_client) {
    _client = createPublicClient({ chain: hederaMainnet, transport: http() });
  }
  return _client;
}

const MAX_TRADE_BPS_ABI = [
  {
    type: "function",
    name: "maxTradeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Live per-trade SY cap for `market` = maxTradeBps()·totalSy()/1e4, minus 0.1%
 * headroom. Returns 0n on any read failure (→ caller does not clamp).
 */
export async function readLiveTradeCap(
  market: `0x${string}`,
): Promise<bigint> {
  try {
    const c = client();
    const [bps, totalSy] = await Promise.all([
      c.readContract({
        abi: MAX_TRADE_BPS_ABI,
        address: ADDRESSES.periphery,
        functionName: "maxTradeBps",
      }) as Promise<bigint>,
      c.readContract({
        abi: marketAbi,
        address: market,
        functionName: "totalSy",
      }) as Promise<bigint>,
    ]);
    if (bps <= 0n || totalSy <= 0n) return 0n;
    const cap = (totalSy * bps) / 10_000n;
    return (cap * 9990n) / 10_000n; // −0.1% headroom vs totalSy drift
  } catch {
    return 0n;
  }
}

// SELF-ADAPTING SIZING (2026-05-31): every limit below is read LIVE from chain on
// each quote — maxTradeBps, totalSy/totalPt, and (critically) the periphery's
// frontable SY balance — so the UI never relies on a hardcoded cap and the limits
// track the pool / reserve / owner-set bps automatically with no code edits.

const ERC20_BAL_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const SY_SHARETOKEN_ABI = [
  { type: "function", name: "shareToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const MARKET_SY_ABI = [
  { type: "function", name: "sy", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

// SY share token per market is immutable — resolve once (market.sy().shareToken())
// and cache, so we never hardcode it and never re-read it per keystroke.
const _shareTokenCache = new Map<string, `0x${string}`>();
async function shareTokenOf(market: `0x${string}`): Promise<`0x${string}` | null> {
  const key = market.toLowerCase();
  const hit = _shareTokenCache.get(key);
  if (hit) return hit;
  try {
    const c = client();
    const sy = (await c.readContract({ abi: MARKET_SY_ABI, address: market, functionName: "sy" })) as `0x${string}`;
    const share = (await c.readContract({ abi: SY_SHARETOKEN_ABI, address: sy, functionName: "shareToken" })) as `0x${string}`;
    _shareTokenCache.set(key, share);
    return share;
  } catch {
    return null;
  }
}

/**
 * Frontable SY the Periphery can put up for a leveraged Buy-YT right now = its
 * SY-share balance (== syReserve when whole). This is the working capital that
 * bounds the leveraged front. 0n on read failure.
 */
export async function readPeripheryFrontable(market: `0x${string}`): Promise<bigint> {
  try {
    const share = await shareTokenOf(market);
    if (!share) return 0n;
    return (await client().readContract({
      abi: ERC20_BAL_ABI, address: share, functionName: "balanceOf", args: [ADDRESSES.periphery],
    })) as bigint;
  } catch {
    return 0n;
  }
}

export interface LeveragedYtQuote {
  /** Frontable, reserve-clamped YT amount — SAFE to submit (never reverts InsufficientReserve). */
  ytOut: bigint;
  /** What the curve/cap alone would give, before the reserve clamp. */
  lensYt: bigint;
  /** Real SY spent (refund = budget − netCost). */
  netCost: bigint;
  /** Frontable reserve at quote time. */
  peripheryBal: bigint;
  /** True iff the protocol working-capital reserve (not the budget or pool cap) bound the size. */
  reserveClamped: boolean;
}

/**
 * YT-LEVERAGE: size a leveraged Buy-YT, reserve-aware. Reads live maxTradeBps +
 * Lens previewBuyYt for the curve/cap size, AND the periphery's frontable SY
 * balance, then clamps ytOut to (frontableBalance + budget) so the subsequent
 * buySyForYt(ytOut, maxSyIn=budget, …) can NEVER revert InsufficientReserve.
 * −0.1% headroom on the reserve term absorbs same-block drift. Returns a zeroed
 * quote on any read failure so the caller aborts cleanly.
 */
export async function previewLeveragedYt(
  market: `0x${string}`,
  syBudget: bigint,
): Promise<LeveragedYtQuote> {
  const empty: LeveragedYtQuote = { ytOut: 0n, lensYt: 0n, netCost: 0n, peripheryBal: 0n, reserveClamped: false };
  if (syBudget <= 0n) return empty;
  try {
    const c = client();
    const bps = (await c.readContract({
      abi: MAX_TRADE_BPS_ABI, address: ADDRESSES.periphery, functionName: "maxTradeBps",
    })) as bigint;
    const [res, peripheryBal] = await Promise.all([
      c.readContract({
        abi: lensAbi, address: ADDRESSES.lens, functionName: "previewBuyYt", args: [market, syBudget, Number(bps)],
      }) as Promise<readonly [bigint, bigint]>,
      readPeripheryFrontable(market),
    ]);
    const lensYt = res[0] ?? 0n;
    const netCost = res[1] ?? 0n;
    // Periphery fronts ytOut from (its SY balance + the user's maxSyIn≈budget).
    const frontHi = (peripheryBal * 9990n) / 10_000n + syBudget;
    const ytOut = lensYt < frontHi ? lensYt : frontHi;
    return { ytOut, lensYt, netCost, peripheryBal, reserveClamped: ytOut < lensYt };
  } catch {
    return empty;
  }
}

/**
 * Live max a single Buy-PT can take, as a raw SY-in amount =
 * min(maxTradeBps·totalSy/1e4, 1%·(totalSy+totalPt)) − 0.1%. Both terms read live
 * so the limit self-adapts to the pool and the owner-set bps. 0n on read failure.
 */
export async function maxPtBuyable(market: `0x${string}`): Promise<bigint> {
  try {
    const c = client();
    const [bps, totalSy, totalPt] = await Promise.all([
      c.readContract({ abi: MAX_TRADE_BPS_ABI, address: ADDRESSES.periphery, functionName: "maxTradeBps" }) as Promise<bigint>,
      c.readContract({ abi: marketAbi, address: market, functionName: "totalSy" }) as Promise<bigint>,
      c.readContract({ abi: marketAbi, address: market, functionName: "totalPt" }) as Promise<bigint>,
    ]);
    if (bps <= 0n || totalSy <= 0n) return 0n;
    const ammCap = (totalSy * bps) / 10_000n;
    const depthCap = (totalSy + totalPt) / 100n; // 1% pool-depth slippage gate
    const cap = ammCap < depthCap ? ammCap : depthCap;
    return (cap * 9990n) / 10_000n;
  } catch {
    return 0n;
  }
}

/**
 * Live max a single Buy-YT can deliver, returned as the NET SY cost (raw) of the
 * largest frontable YT buy — i.e. the YT *value* the user can acquire right now.
 * Bound by BOTH the pool 10% clamp (lens previewBuyYt at a huge budget) AND the
 * periphery's frontable reserve. Multiply by usdPerShare for the $ figure.
 * 0n on read failure.
 */
export async function maxYtBuyable(market: `0x${string}`): Promise<bigint> {
  try {
    const c = client();
    const bps = (await c.readContract({
      abi: MAX_TRADE_BPS_ABI, address: ADDRESSES.periphery, functionName: "maxTradeBps",
    })) as bigint;
    const [res, frontable] = await Promise.all([
      // Huge budget → previewBuyYt returns the pool-clamp ytOut + its net cost.
      c.readContract({
        abi: lensAbi, address: ADDRESSES.lens, functionName: "previewBuyYt",
        args: [market, 10n ** 30n, Number(bps)],
      }) as Promise<readonly [bigint, bigint]>,
      readPeripheryFrontable(market),
    ]);
    const poolMaxYt = res[0] ?? 0n;   // 10% (or bps) clamp on ytOut
    const poolMaxCost = res[1] ?? 0n; // net SY cost to buy poolMaxYt
    if (poolMaxYt <= poolMaxCost || poolMaxYt === 0n) return 0n;
    // Reserve-bound net cost: the periphery fronts ytOut from (reserve + budget),
    // and budget≈netCost, so reserve >= ytOut - netCost = ytOut*(1 - ytPriceSy).
    // => max net cost = frontable * poolMaxCost / (poolMaxYt - poolMaxCost).
    const reserveBoundCost = (frontable * poolMaxCost) / (poolMaxYt - poolMaxCost);
    return poolMaxCost < reserveBoundCost ? poolMaxCost : reserveBoundCost;
  } catch {
    return 0n;
  }
}
