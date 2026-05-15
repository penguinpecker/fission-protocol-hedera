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
  // ───── ActionRouter v3 (our writes) — verified via keccak256 2026-05-15
  "0xbf35db06": "swapExactSyForPt",
  "0x690b343f": "swapExactPtForSy",
  "0xc158091f": "buyYT",
  "0x15ee88c3": "addLiquidityProportional",
  "0xcff15d64": "removeLiquidityProportional",
  "0xd1e04b89": "depositAndSplit",
  "0x82b1d54d": "redeemAfterExpiryAndUnwrap",
  // ───── Market (direct) — verified via keccak256 2026-05-15
  "0xdbceb005": "split",
  "0x59d20b37": "splitTo",
  "0x1d64ab72": "merge",
  "0x4c2e00d2": "merge",
  "0x7fd2778e": "redeemAfterExpiry",
  "0xffec999b": "redeemAfterExpiry",
  "0xb576468e": "addLiquidity",
  "0xe39b0eb5": "removeLiquidity",
  "0x73a888f6": "swapExactSyForPt",
  "0x8488ba33": "swapExactPtForSy",
  // ───── SY adapter — verified via keccak256 2026-05-15
  "0x0c887b94": "depositLiquidity",
  "0x675e3a96": "redeemLiquidity",
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
