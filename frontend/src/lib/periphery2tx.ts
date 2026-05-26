/**
 * 2-tx Periphery helpers — the canonical user-flow API after the 2026-05-27
 * clean-slate redeploy. Each Buy/Sell flow is exposed as a single async
 * function that internally chains the two on-chain txs, exposing a step
 * callback so the UI can show "Step 1/2 → Step 2/2" progress.
 *
 * One-time setup (user must do once per dApp connection):
 *   - approveErc20: PT, LP, SY-share → Periphery (MAX_HTS_APPROVE)
 *   - market.setOperator(periphery, true) for YT-sell support
 *
 * Then every Buy/Sell is two txs:
 *   Buy:  zapHbarToSy → buySyForPt / buySyForYt / buySyForLp
 *   Sell: sellPtForSy / sellYtForSy / sellLpForSy → unzapSyToHbar
 */

import { fissionPeripheryAbi } from "./abis-write";
import { ADDRESSES, MAX_HTS_APPROVE } from "./addresses";

const NO_DEADLINE = 0n;

export type StepCallback = (step: 1 | 2, label: string, txHash?: string) => void;

export interface WriteAdapter {
  address: `0x${string}` | null;
  write: (op: any) => Promise<{ txHash: string }>;
  waitForReceipt?: (txHash: string) => Promise<void>;
}

/**
 * Tx 1 of every Buy flow: HBAR → SY shares, delivered to `receiver` (user).
 * The receiver's SY balance delta is what gets passed to Tx 2.
 */
export async function zapHbarToSy(
  adapter: WriteAdapter,
  market: `0x${string}`,
  hbarInTinybars: bigint
): Promise<{ txHash: string }> {
  if (!adapter.address) throw new Error("Wallet not connected");
  return adapter.write({
    kind: "writeContract",
    address: ADDRESSES.periphery,
    abi: fissionPeripheryAbi,
    functionName: "zapHbarToSy",
    args: [market, adapter.address, NO_DEADLINE],
    value: hbarInTinybars,
  });
}

/**
 * Tx 2 of Buy PT: SY → PT with exact ptOut, syIn capped.
 * Frontend should query Lens.previewSwapExactSyForPt to compute realistic ptOut.
 */
export async function buySyForPt(
  adapter: WriteAdapter,
  market: `0x${string}`,
  syIn: bigint,
  minPtOut: bigint
): Promise<{ txHash: string }> {
  if (!adapter.address) throw new Error("Wallet not connected");
  return adapter.write({
    kind: "writeContract",
    address: ADDRESSES.periphery,
    abi: fissionPeripheryAbi,
    functionName: "buySyForPt",
    args: [market, syIn, minPtOut, adapter.address, NO_DEADLINE],
  });
}

/**
 * Tx 2 of Buy YT: SY → YT (internally splits + sells PT for SY refund).
 */
export async function buySyForYt(
  adapter: WriteAdapter,
  market: `0x${string}`,
  syIn: bigint,
  minSyOutFromPtSale: bigint
): Promise<{ txHash: string }> {
  if (!adapter.address) throw new Error("Wallet not connected");
  return adapter.write({
    kind: "writeContract",
    address: ADDRESSES.periphery,
    abi: fissionPeripheryAbi,
    functionName: "buySyForYt",
    args: [market, syIn, minSyOutFromPtSale, adapter.address, NO_DEADLINE],
  });
}

/**
 * Tx 2 of Buy LP: SY → LP (proportional add).
 * NOTE: Current Periphery uses internal swap with ptOut=1; produces minimal LP.
 * Frontend needs to compute proper proportions via Lens for non-trivial amounts.
 * Until a Periphery v2 ships, prefer the 3-tx path: zapHbarToSy → swapExactSyForPt → market.addLiquidity.
 */
export async function buySyForLp(
  adapter: WriteAdapter,
  market: `0x${string}`,
  syIn: bigint,
  ptShareBps: number,
  minLpOut: bigint
): Promise<{ txHash: string }> {
  if (!adapter.address) throw new Error("Wallet not connected");
  return adapter.write({
    kind: "writeContract",
    address: ADDRESSES.periphery,
    abi: fissionPeripheryAbi,
    functionName: "buySyForLp",
    args: [market, syIn, ptShareBps, minLpOut, adapter.address, NO_DEADLINE],
  });
}

/**
 * Tx 1 of Sell PT: PT → SY. User must have approved PT → Periphery.
 */
export async function sellPtForSy(
  adapter: WriteAdapter,
  market: `0x${string}`,
  ptIn: bigint,
  minSyOut: bigint
): Promise<{ txHash: string }> {
  if (!adapter.address) throw new Error("Wallet not connected");
  return adapter.write({
    kind: "writeContract",
    address: ADDRESSES.periphery,
    abi: fissionPeripheryAbi,
    functionName: "sellPtForSy",
    args: [market, ptIn, minSyOut, adapter.address, NO_DEADLINE],
  });
}

/**
 * Tx 1 of Sell YT: YT → SY. User must have called market.setOperator(periphery, true).
 */
export async function sellYtForSy(
  adapter: WriteAdapter,
  market: `0x${string}`,
  ytIn: bigint,
  minSyOut: bigint
): Promise<{ txHash: string }> {
  if (!adapter.address) throw new Error("Wallet not connected");
  return adapter.write({
    kind: "writeContract",
    address: ADDRESSES.periphery,
    abi: fissionPeripheryAbi,
    functionName: "sellYtForSy",
    args: [market, ytIn, minSyOut, adapter.address, NO_DEADLINE],
  });
}

/**
 * Tx 1 of Sell LP: LP → SY (burns LP, swaps PT half to SY).
 */
export async function sellLpForSy(
  adapter: WriteAdapter,
  market: `0x${string}`,
  lpIn: bigint,
  minSyOut: bigint
): Promise<{ txHash: string }> {
  if (!adapter.address) throw new Error("Wallet not connected");
  return adapter.write({
    kind: "writeContract",
    address: ADDRESSES.periphery,
    abi: fissionPeripheryAbi,
    functionName: "sellLpForSy",
    args: [market, lpIn, minSyOut, adapter.address, NO_DEADLINE],
  });
}

/**
 * Tx 2 of every Sell flow: SY → HBAR. User must have approved SY-share → Periphery.
 */
export async function unzapSyToHbar(
  adapter: WriteAdapter,
  syAdapter: `0x${string}`,
  sharesIn: bigint,
  minHbarOut: bigint
): Promise<{ txHash: string }> {
  return adapter.write({
    kind: "writeContract",
    address: ADDRESSES.periphery,
    abi: fissionPeripheryAbi,
    functionName: "unzapSyToHbar",
    args: [syAdapter, sharesIn, minHbarOut, NO_DEADLINE],
  });
}
