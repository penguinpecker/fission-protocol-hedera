/**
 * Tiny client-side lookup table that maps Solidity function selectors
 * (`0x` + first 4 bytes of keccak256(signature)) to human-readable names.
 *
 * Used by /profile's `// recent_activity` feed to label each contract call
 * with the actual function the user invoked, instead of the generic
 * "contractCall" string Mirror Node emits. Only the functions we actually
 * call from our frontend + the common HTS-precompile ones are listed —
 * anything else falls back to "call" with the raw selector shown.
 */

export const SELECTOR_NAMES: Record<string, string> = {
  // ───── ActionRouter (our writes)
  "0xbf35db06": "swapExactSyForPt",
  "0xc158091f": "buyYT",
  "0xe6f5b25a": "addLiquidityProportional",
  "0xa9da11cc": "removeLiquidityProportional",
  "0xc9bf2c2c": "depositAndSplit",
  "0x9be3c50d": "redeemAfterExpiryAndUnwrap",
  // ───── Market (direct)
  "0xdbceb005": "split",
  "0x24a47aeb": "merge",
  "0xffec999b": "redeemAfterExpiry",
  "0xc681bea7": "addLiquidity",
  "0xc23d3eef": "removeLiquidity",
  // ───── SY adapter
  "0xff5f3b56": "depositLiquidity",
  "0xb3f5dfc7": "redeemLiquidity",
  "0x4641257d": "harvest",
  "0x4e71d92d": "claim",
  // ───── FissionZap
  "0xe056955f": "zapHbarToSy",
  // ───── HTS / ERC-20 standard
  "0x095ea7b3": "approve",
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
  "0x42966c68": "burn",
  "0x40c10f19": "mint",
  // ───── HTS precompile helpers
  "0x49146bde": "associate",
  "0x2e64cec1": "associate (multi)",
};

/**
 * Returns a friendly function name for a `function_parameters` value (raw
 * `0x…` calldata or just the 10-char selector). Falls back to
 * `call(<selector>)` if unknown so the user at least sees what to look up.
 */
export function decodeSelector(callData: string | undefined | null): string {
  if (!callData) return "call";
  const sel = callData.startsWith("0x") ? callData.slice(0, 10).toLowerCase() : `0x${callData.slice(0, 8).toLowerCase()}`;
  const known = SELECTOR_NAMES[sel];
  if (known) return known;
  // Unknown but well-formed selector — surface it so a curious user can grep.
  if (/^0x[0-9a-f]{8}$/.test(sel)) return `call(${sel})`;
  return "call";
}
