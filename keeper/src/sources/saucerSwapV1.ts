import type { Address, PublicClient } from "viem";
import { saucerSwapV1SyExtraAbi, uniswapV2PairAbi } from "../abi.ts";

/**
 * Compute the SY-adapter rate from the on-chain pool: ratio of current
 * `sqrt(r0 * r1) * 1e18 / totalSupply` against the SY's frozen `initialVirtualPrice`.
 */
export async function fetchSaucerSwapV1Rate(client: PublicClient, sy: Address): Promise<bigint> {
  // Read the pool address and initial virtual price off the SY itself, so the keeper
  // doesn't have to be re-configured if the protocol moves SY to a different pool.
  const [pool, initialVp] = await Promise.all([
    client.readContract({ address: sy, abi: saucerSwapV1SyExtraAbi, functionName: "pool" }),
    client.readContract({ address: sy, abi: saucerSwapV1SyExtraAbi, functionName: "initialVirtualPrice" }),
  ]);

  const [reserves, ts] = await Promise.all([
    client.readContract({ address: pool, abi: uniswapV2PairAbi, functionName: "getReserves" }),
    client.readContract({ address: pool, abi: uniswapV2PairAbi, functionName: "totalSupply" }),
  ]);
  const [r0, r1] = reserves;

  if (ts === 0n) throw new Error("pool totalSupply is zero");
  const product = BigInt(r0) * BigInt(r1);
  if (product === 0n) throw new Error("pool reserves are zero");
  const sqrtK = bigintSqrt(product);
  const currentVp = (sqrtK * 10n ** 18n) / ts;
  if (initialVp === 0n) throw new Error("initialVirtualPrice is zero");

  return (currentVp * 10n ** 18n) / initialVp;
}

/**
 * Integer sqrt for bigints. Babylonian / Newton's method. Sufficient precision for
 * any uint256 input — last few ULPs may differ from Solady's sqrt() but the bps
 * cap on the SY contract will tolerate the rounding.
 */
export function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("negative input");
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
