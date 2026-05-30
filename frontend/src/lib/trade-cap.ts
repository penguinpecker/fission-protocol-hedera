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
import { marketAbi } from "@/lib/abis";
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
