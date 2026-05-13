/**
 * Per-contract ABI registry used by `/api/activity` to decode each call the user
 * made into a human-readable action + amount + token.
 *
 * The selector-only table in `lib/selector-decoder.ts` can give us the function
 * name, but not the args — to render "+1,000,000 PT" the decoder needs to know
 * the input types of the call. This registry pins one ABI per contract we
 * actually own (Router, Factory, Zap, Market, SY adapter, share token, PT, YT,
 * LP), keyed by the EVM address as a lowercase 0x string.
 *
 * Addresses come from `/deployments/295.json`. Hedera contracts have two valid
 * EVM addresses: the deterministic CREATE2-style address (e.g. Market 0 at
 * 0xfa90…8a6d) AND a long-zero alias formed from the entity number (e.g.
 * 0x…009fb0b4 for that same Market 0). Mirror Node `/contracts/results`
 * surfaces the long-zero `to` for HAPI calls and the CREATE2 form for relay
 * calls, so we register BOTH whenever a contract has both. The lookup is
 * lower-cased.
 */

import { factoryAbi, marketAbi, syAbi, erc20Abi } from "./abis";
import {
  routerAbi,
  erc20WriteAbi,
  fissionZapAbi,
  syWriteAbi,
  marketWriteAbi,
} from "./abis-write";

// viem's `decodeFunctionData` only needs the *function* entries — it ignores
// events. We merge read + write ABIs per contract so a single registry entry
// can cover any selector that contract exposes.
//
// Using `unknown[]` here keeps the registry value's TS shape narrow enough to
// satisfy `decodeFunctionData`'s `Abi` param without us having to enumerate
// each ABI's `as const` literal type. The runtime shape is identical.
type AbiList = readonly unknown[];

export interface RegistryEntry {
  /** Short, user-facing label for this contract (rendered in activity rows). */
  name: string;
  /** Merged read + write ABI for this contract. */
  abi: AbiList;
}

const ROUTER = "0x00000000000000000000000000000000009fd993";
const FACTORY = "0x00000000000000000000000000000000009fb0b3";
const ZAP = "0x00000000000000000000000000000000009fd984";

// Market 0 is reachable via two EVM addresses (see file header).
const MARKET_0_CREATE2 = "0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d";
const MARKET_0_LONGZERO = "0x00000000000000000000000000000000009fb0b4";

const SY_LP = "0x00000000000000000000000000000000009fb089";
const SY_SHARE_TOKEN = "0x00000000000000000000000000000000009fb08b";
const PT_TOKEN = "0x00000000000000000000000000000000009fb0b5";
const YT_TOKEN = "0x00000000000000000000000000000000009fb0b6";
const LP_TOKEN = "0x00000000000000000000000000000000009fb0b7";

// Merge helper — declared once so each entry below is one line. The casts to
// `readonly unknown[]` are necessary because each input ABI carries its own
// `as const` literal type which doesn't unify under a single readonly array.
const merge = (...abis: readonly AbiList[]): AbiList =>
  abis.flatMap((a) => a as readonly unknown[]);

const marketAbiAll: AbiList = merge(marketAbi, marketWriteAbi);
const syAbiAll: AbiList = merge(syAbi, syWriteAbi);
const erc20AbiAll: AbiList = merge(erc20Abi, erc20WriteAbi);

export const ACTIVITY_REGISTRY: Record<string, RegistryEntry> = {
  [ROUTER]: { name: "ActionRouter", abi: routerAbi },
  [FACTORY]: { name: "FissionFactory", abi: factoryAbi },
  [ZAP]: { name: "FissionZap", abi: fissionZapAbi },
  [MARKET_0_CREATE2]: { name: "Market 0", abi: marketAbiAll },
  [MARKET_0_LONGZERO]: { name: "Market 0", abi: marketAbiAll },
  [SY_LP]: { name: "SY adapter", abi: syAbiAll },
  [SY_SHARE_TOKEN]: { name: "SY share token", abi: erc20AbiAll },
  [PT_TOKEN]: { name: "PT-SS-V2-90D", abi: erc20AbiAll },
  [YT_TOKEN]: { name: "YT-SS-V2-90D", abi: erc20AbiAll },
  [LP_TOKEN]: { name: "LP-SS-V2-90D", abi: erc20AbiAll },
};

export function lookupContract(address: string | undefined | null): {
  label: string;
  abi: AbiList | null;
} {
  if (!address) return { label: "Unknown", abi: null };
  const entry = ACTIVITY_REGISTRY[address.toLowerCase()];
  if (!entry) return { label: shortAddr(address), abi: null };
  return { label: entry.name, abi: entry.abi };
}

function shortAddr(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─────────────────────────── token metadata ───────────────────────────

/**
 * Per-token display info — `token` is the ticker shown in the amount block,
 * `decimals` formats the raw uint into a human number. Keyed by lowercased EVM
 * address (both CREATE2 + long-zero where they exist).
 *
 * SY share token / PT / YT / LP are HTS-native tokens — Hedera mints them with
 * the decimals declared in the constructor; we mirror that here.
 *
 * "kind" lets the route attach a USD value: only `sy` is currently priced via
 * the V3-NFT-derived `usdPerShare` (see `useSyValueUsd`). PT pays 1:1 in SY at
 * maturity so we *could* price it as ~SY-equivalent, but pre-maturity that
 * over-states value; we leave PT/YT/LP USD blank to avoid lying.
 */
export interface TokenInfo {
  symbol: string;
  decimals: number;
  kind: "sy" | "pt" | "yt" | "lp" | "usdc" | "whbar" | "other";
}

const SS_SUFFIX = "SS-V2-90D";

export const TOKEN_INFO: Record<string, TokenInfo> = {
  [SY_SHARE_TOKEN]: { symbol: `SY-${SS_SUFFIX}`, decimals: 18, kind: "sy" },
  [SY_LP]: { symbol: `SY-${SS_SUFFIX}`, decimals: 18, kind: "sy" },
  [PT_TOKEN]: { symbol: `PT-${SS_SUFFIX}`, decimals: 18, kind: "pt" },
  [YT_TOKEN]: { symbol: `YT-${SS_SUFFIX}`, decimals: 18, kind: "yt" },
  [LP_TOKEN]: { symbol: `LP-${SS_SUFFIX}`, decimals: 18, kind: "lp" },
  "0x000000000000000000000000000000000006f89a": { symbol: "USDC", decimals: 6, kind: "usdc" },
  "0x0000000000000000000000000000000000163b5a": { symbol: "WHBAR", decimals: 8, kind: "whbar" },
  "0x0000000000000000000000000000000000163b59": { symbol: "WHBAR", decimals: 8, kind: "whbar" },
};

export function lookupToken(address: string | undefined | null): TokenInfo | null {
  if (!address) return null;
  return TOKEN_INFO[address.toLowerCase()] ?? null;
}

// ─────────────────────────── action labels ───────────────────────────

/**
 * Maps a (contractLabel, functionName) pair to a user-facing action string.
 * Keep these terse — they show up in a single 11.5px row, no truncation
 * affordance — and tense-consistent ("Buy PT", "Add liquidity", not "Bought").
 *
 * For functions we know but the contract isn't in the registry, we fall back
 * to the function name verbatim (matches today's behaviour). For functions we
 * don't know at all, `selector-decoder.ts` is the final fallback.
 */
export function actionLabel(contractLabel: string, functionName: string): string {
  // Approve gets a special form because the spender determines what was
  // approved (router vs market vs zap). The route fills the spender label in
  // separately — here we just produce a generic stub.
  switch (functionName) {
    case "swapExactSyForPt":
      return "Buy PT";
    case "swapExactPtForSy":
      return "Sell PT";
    case "buyYT":
      return "Buy YT";
    case "depositAndSplit":
      return "Mint & split";
    case "split":
      return "Split SY";
    case "merge":
      return "Merge PT+YT";
    case "addLiquidity":
    case "addLiquidityProportional":
      return "Add liquidity";
    case "removeLiquidity":
    case "removeLiquidityProportional":
      return "Remove liquidity";
    case "redeemAfterExpiry":
    case "redeemAfterExpiryAndUnwrap":
      return "Redeem PT";
    case "claimYield":
    case "harvest":
      return "Claim yield";
    case "depositLiquidity":
      return "Mint SY";
    case "claimRewards":
      return "Claim rewards";
    case "zapHbarToSy":
      return "Zap HBAR → SY";
    case "approve":
      return `Approve ${contractLabel}`;
    case "transfer":
      return `Transfer ${contractLabel}`;
    case "transferFrom":
      return `Transfer ${contractLabel}`;
    case "unwrapSY":
      return "Unwrap SY";
    default:
      return functionName;
  }
}

/**
 * For a decoded call, returns the "primary" argument to surface as the amount
 * + the token whose decimals/ticker label that amount. Returns null when no
 * meaningful arg exists (read-only views, claim with no input amount, etc.).
 *
 * Conventions:
 *   - Router fns: the `*In` arg, with the target market's PT/YT/LP token as label
 *     where the fn implies which side the amount belongs to (e.g. swapExactSyForPt
 *     → `syIn` measured in SY).
 *   - Market.split: the SY amount being split.
 *   - approve/transfer: the `amount` field, labeled by *this* contract (the
 *     ERC-20 being approved is the contract we're decoding).
 *
 * `side` is a UI hint — "out" = user sent it (approve, sell, transfer, deposit),
 * "in" = user received it (claim, harvest). For trades we keep it "out" because
 * the amount-arg is what the user spent; the *output* amount is in the call
 * result, which Mirror Node exposes but is harder to map back to a ticker.
 */
export interface PrimaryArg {
  /** Raw uint amount as a string (preserves bigint precision over JSON). */
  raw: string;
  /** The token contract whose decimals + symbol describe this amount. */
  tokenAddress: `0x${string}` | null;
  /** Same-token label override if the registry doesn't know the address. */
  tokenSymbol?: string;
  side: "in" | "out";
}

/** Type guard — decoded args from viem are `readonly unknown[]`. */
function bi(v: unknown): bigint | null {
  return typeof v === "bigint" ? v : null;
}
function addr(v: unknown): `0x${string}` | null {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
    ? (v.toLowerCase() as `0x${string}`)
    : null;
}

export function pickPrimaryArg(
  functionName: string,
  args: readonly unknown[] | undefined,
  contractAddress: string,
): PrimaryArg | null {
  if (!args) return null;
  const fromContract = (a: number = 0): `0x${string}` =>
    contractAddress.toLowerCase() as `0x${string}` & { __markerArg?: typeof a };

  // Routes need the market address to find the PT/YT/LP token tied to this
  // call; for v1 we have one market only, so its tokens live in TOKEN_INFO
  // and pickPrimaryArg can return a `kind`-coded address. If we add more
  // markets later this should look up market→token via a separate map.
  const PT = PT_TOKEN as `0x${string}`;
  const YT = YT_TOKEN as `0x${string}`;
  const LP = LP_TOKEN as `0x${string}`;
  const SY_SHARE = SY_SHARE_TOKEN as `0x${string}`;

  switch (functionName) {
    // ── ActionRouter ──
    case "swapExactSyForPt": {
      // (market, syIn, ptOut, receiver, deadline)
      const raw = bi(args[1]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: SY_SHARE, side: "out" };
    }
    case "swapExactPtForSy": {
      // (market, ptIn, minSyOut, receiver, deadline)
      const raw = bi(args[1]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: PT, side: "out" };
    }
    case "buyYT": {
      // (market, syBudget, minSyOutFromPtSale, receiver, deadline)
      const raw = bi(args[1]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: SY_SHARE, side: "out" };
    }
    case "addLiquidityProportional": {
      // (market, syIn, ptIn, minLpOut, receiver, deadline)
      const raw = bi(args[1]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: SY_SHARE, side: "out" };
    }
    case "removeLiquidityProportional": {
      // (market, lpIn, minSyOut, minPtOut, receiver, deadline)
      const raw = bi(args[1]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: LP, side: "out" };
    }
    case "depositAndSplit": {
      // (market, tokenIn, amountIn, minPyOut, receiver, deadline)
      const raw = bi(args[2]);
      const t = addr(args[1]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: t, side: "out" };
    }
    case "redeemAfterExpiryAndUnwrap": {
      // (market, ptIn, tokenOut, minTokenOut, receiver, deadline)
      const raw = bi(args[1]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: PT, side: "out" };
    }
    case "unwrapSY": {
      // (sy, shares, tokenOut, minTokenOut, receiver, deadline)
      const raw = bi(args[1]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: SY_SHARE, side: "out" };
    }

    // ── Market direct ──
    case "split":
    case "merge": {
      // (amount)
      const raw = bi(args[0]);
      if (raw === null) return null;
      // split takes SY, returns PT+YT; merge takes PT+YT, returns SY. Either
      // way the input amount is the SY-equivalent — label as SY.
      return { raw: raw.toString(), tokenAddress: SY_SHARE, side: "out" };
    }
    case "addLiquidity": {
      // (syIn, ptIn, minLpOut, receiver)
      const raw = bi(args[0]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: SY_SHARE, side: "out" };
    }
    case "redeemAfterExpiry": {
      // (ptIn, ytIn, receiver) — both equal at maturity; show ptIn
      const raw = bi(args[0]);
      if (raw === null) return null;
      return { raw: raw.toString(), tokenAddress: PT, side: "out" };
    }
    case "claimYield":
      // (receiver) — no input amount; output is the yield paid
      return null;

    // ── SY adapter ──
    case "depositLiquidity": {
      // (amount0, amount1, amount0Min, amount1Min, receiver, minShares)
      // amount0 = USDC; surface that as the headline number for "Mint SY"
      const raw = bi(args[0]);
      if (raw === null) return null;
      return {
        raw: raw.toString(),
        tokenAddress: "0x000000000000000000000000000000000006f89a" as `0x${string}`,
        side: "out",
      };
    }
    case "harvest":
    case "claimRewards":
      return null;

    // ── FissionZap ──
    case "zapHbarToSy":
      // (sy, usdcMinOut, amount0Min, amount1Min, minShares, receiver) — input is msg.value (HBAR),
      // not in the calldata. Mirror Node's `amount` field on the tx is in tinybars; the route
      // pulls that and overrides this branch. Return null here so the caller knows to use
      // the msg.value path.
      return null;

    // ── ERC-20 / HTS facade ──
    case "approve": {
      // (spender, amount) — the token being approved is the contract we're
      // decoding, so we label by `contractAddress`.
      const raw = bi(args[1]);
      if (raw === null) return null;
      return {
        raw: raw.toString(),
        tokenAddress: fromContract(),
        side: "out",
      };
    }
    case "transfer": {
      // (to, amount)
      const raw = bi(args[1]);
      if (raw === null) return null;
      return {
        raw: raw.toString(),
        tokenAddress: fromContract(),
        side: "out",
      };
    }
    case "transferFrom": {
      // (from, to, amount)
      const raw = bi(args[2]);
      if (raw === null) return null;
      return {
        raw: raw.toString(),
        tokenAddress: fromContract(),
        side: "out",
      };
    }

    default:
      return null;
  }
}
