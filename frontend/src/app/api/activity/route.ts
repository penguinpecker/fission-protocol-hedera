/**
 * /api/activity — decoded contract-call feed for a single user.
 *
 * Pipeline:
 *   1. Pull the last ~10 calls from Hedera Mirror Node's `/contracts/results`
 *      endpoint (filtered by `from=<userEvm>`). This is the only public source
 *      that includes raw `function_parameters` (calldata) per call — needed for
 *      arg decoding. `/transactions` doesn't carry it.
 *   2. For each call, look up the destination contract in the ABI registry
 *      (see `lib/activity-abi-registry.ts`). Decode the calldata with viem's
 *      `decodeFunctionData` to recover the function name + args.
 *   3. Map (contractLabel, functionName) → user-facing action ("Buy PT").
 *   4. Pick the most-meaningful arg as the headline amount (e.g. `syIn` for
 *      `swapExactSyForPt`) and format it using the token's decimals + ticker.
 *   5. If the token is the SY share, compute a USD value via the V3 NFT
 *      decomposition (USDC peg + WHBAR/CoinGecko price). Per-page-load cache.
 *   6. If the destination isn't in the registry, fall back to
 *      `decodeSelector(...)` so the row still shows a function name (no amount).
 *
 * Response time budget: <500ms for 10 recent calls. The Mirror Node fetch is
 * one round trip (<200ms typical); the optional SY-value computation adds ~3
 * RPC reads + 1 CoinGecko hit, both module-scope cached with a 60s TTL.
 *
 * Cache: in-memory, module-scope. Two caches —
 *   - `hbarUsdCache`: HBAR/USD price (60s TTL).
 *   - `syUsdPerShareCache`: USD/share derived from V3 NFT amounts (60s TTL).
 * Both shared across requests, both fail-soft (route still returns the rest of
 * the entry without USD if the cache miss + refetch fails).
 */

import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient, decodeFunctionData, http } from "viem";
import type { Abi } from "viem";
import { hederaMainnet } from "@/lib/chains";
import { erc20Abi, syAbi } from "@/lib/abis";
import {
  lookupContract,
  lookupToken,
  actionLabel,
  pickPrimaryArg,
} from "@/lib/activity-abi-registry";
import { decodeSelector } from "@/lib/selector-decoder";
import { createServiceRoleClient } from "@/lib/supabase/server";

// ─────────────────────────────── types ───────────────────────────────

export interface ActivityAmount {
  /** Ticker shown on the row (e.g. "SY-SS-V2-90D"). */
  token: string;
  /** Raw uint as a JSON-safe string. Caller can parse if needed. */
  raw: string;
  /** Pretty-printed amount, already scaled by decimals + compacted. */
  formatted: string;
  /** Optional USD value when the token has a server-side price source. */
  usd?: number;
}

export interface ActivityEntry {
  txId: string;
  timestamp: number;
  contract: { address: `0x${string}`; id: string | null; label: string };
  action: string;
  result: string;
  amount?: ActivityAmount;
  side?: "in" | "out";
  hashscanUrl: string;
}

interface MirrorContractResult {
  hash: string;
  timestamp: string;
  to: string;
  from: string;
  contract_id: string | null;
  function_parameters: string | null;
  result: string;
  amount?: number; // tinybars, for HBAR-bearing calls
}

interface MirrorContractResultsResponse {
  results: MirrorContractResult[];
}

// ─────────────────────────────── caches ───────────────────────────────

interface CacheEntry<T> {
  value: T;
  ts: number;
}

const TTL_MS = 60_000;

let hbarUsdCache: CacheEntry<number | null> | null = null;
let syUsdPerShareCache: CacheEntry<number | null> | null = null;

function freshlyCached<T>(c: CacheEntry<T> | null): T | undefined {
  if (!c) return undefined;
  if (Date.now() - c.ts > TTL_MS) return undefined;
  return c.value;
}

// ─────────────────────────────── handler ───────────────────────────────

// Shape of activity_log rows stored by the cron-indexer Railway worker.
interface ActivityLogRow {
  tx_hash: string;
  address: string;
  event_type: string;
  market_address: string | null;
  block_timestamp: string;
  block_number: number | null;
  payload: {
    contract?: string;
    contract_evm?: string;
    to?: string;
    amount_tinybars?: number;
    gas_used?: number;
    result?: string;
    error_message?: string | null;
    function_parameters?: string;
    timestamp_consensus?: string;
  } | null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  const limitParam = url.searchParams.get("limit");
  const limit = Math.max(1, Math.min(50, Number(limitParam) || 10));

  if (!address || !/^(0x[0-9a-fA-F]{40}|0\.0\.\d+)$/.test(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  // Mirror Node stores `from` as the account's long-zero alias for Hedera-
  // native accounts (0x000...<accountNum>), not the ECDSA-derived EVM alias.
  // So a user with both forms (HashPack ECDSA via wallet-connect) gets indexed
  // under the long-zero. Resolve both forms and query OR so the user's
  // history appears regardless of which address the frontend passes.
  const candidates = await resolveAddressForms(address);

  // Read from the persisted index (kept warm by the cron-indexer Railway
  // worker which polls Hedera Mirror Node every 60s). Falls back to mirror
  // on Supabase failure so a transient DB outage doesn't blank the feed.
  let rows: ActivityLogRow[] = [];
  let usedFallback = false;
  try {
    const supa = createServiceRoleClient();
    const { data, error } = await supa
      .from("activity_log")
      .select("tx_hash,address,event_type,market_address,block_timestamp,block_number,payload")
      .in("address", candidates)
      .order("block_timestamp", { ascending: false })
      .limit(limit);
    if (error) throw error;
    rows = (data ?? []) as ActivityLogRow[];
  } catch {
    // Fallback: read mirror live. Same path the route used pre-indexer.
    usedFallback = true;
    rows = await fetchMirrorFallback(address, limit);
  }

  // SY USD per share — read the warm cache if fresh, otherwise refresh INLINE.
  let syUsdPerShare = freshlyCached(syUsdPerShareCache);
  if (syUsdPerShare === undefined) {
    await refreshSyUsdPerShare();
    syUsdPerShare = freshlyCached(syUsdPerShareCache);
  }

  const entries: ActivityEntry[] = rows
    .map((row) => decodeRow(toMirrorShape(row), syUsdPerShare ?? null))
    .filter((e): e is ActivityEntry => e !== null);

  return NextResponse.json({ entries, source: usedFallback ? "mirror_fallback" : "activity_log" });
}

// Adapt an activity_log row to the shape decodeRow expects.
function toMirrorShape(row: ActivityLogRow): MirrorContractResult {
  const p = row.payload ?? {};
  return {
    hash: row.tx_hash,
    // block_timestamp is ISO; decodeRow wants `seconds.nanos`. Use stored
    // consensus timestamp when present (lossless), otherwise convert ISO.
    timestamp: p.timestamp_consensus ?? `${Math.floor(new Date(row.block_timestamp).getTime() / 1000)}.0`,
    to: (p.to ?? p.contract_evm ?? "").toLowerCase(),
    from: row.address,
    contract_id: null,
    function_parameters: p.function_parameters ?? null,
    result: p.result ?? "SUCCESS",
    amount: typeof p.amount_tinybars === "number" ? p.amount_tinybars : undefined,
  };
}

// Mirror-direct fallback used when Supabase is unavailable.
/**
 * Resolve a single user address into all the forms Mirror Node might have
 * indexed it under:
 *   1. The user-supplied form (lower-cased EVM hex).
 *   2. The long-zero alias `0x000...<accountNum hex>` for the Hedera account.
 *   3. The ECDSA-derived EVM alias from the account's public key, if different
 *      from #1 (mirror returns `evm_address` field with the canonical alias).
 *
 * The cron-indexer writes `from` exactly as Mirror Node returns it — which is
 * the long-zero for Hedera-native sigs and the EVM alias for ECDSA-keyed
 * accounts that have aliased. This helper normalises both directions.
 */
async function resolveAddressForms(input: string): Promise<string[]> {
  const out = new Set<string>();
  const lower = input.toLowerCase();
  out.add(lower);

  // Hedera account-ID form "0.0.NNNN" → derive long-zero immediately.
  if (/^0\.0\.\d+$/.test(input)) {
    const num = Number(input.split(".")[2]);
    out.add("0x" + num.toString(16).padStart(40, "0"));
  }

  // Look up mirror to find the EVM alias (for long-zero input) or the
  // account ID (for EVM input). Either direction yields the other form.
  try {
    const r = await fetch(
      `https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${input}`,
      { cache: "no-store" },
    );
    if (r.ok) {
      const d = (await r.json()) as { account?: string; evm_address?: string };
      if (d.evm_address) out.add(d.evm_address.toLowerCase());
      if (d.account) {
        const num = Number(d.account.split(".")[2]);
        if (Number.isFinite(num)) {
          out.add("0x" + num.toString(16).padStart(40, "0"));
        }
      }
    }
  } catch {
    /* fall through with just the input form */
  }

  return [...out];
}

async function fetchMirrorFallback(address: string, limit: number): Promise<ActivityLogRow[]> {
  const mirrorBase =
    process.env.NEXT_PUBLIC_MIRROR_NODE_URL ??
    "https://mainnet-public.mirrornode.hedera.com";
  try {
    const res = await fetch(
      `${mirrorBase}/api/v1/contracts/results?from=${address}&limit=${limit}&order=desc`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const j = (await res.json()) as MirrorContractResultsResponse;
    return (j.results ?? []).map((r) => ({
      tx_hash: r.hash,
      address: (r.from ?? "").toLowerCase(),
      event_type: "fallback",
      market_address: null,
      block_timestamp: new Date(Number(r.timestamp.split(".")[0]) * 1000).toISOString(),
      block_number: null,
      payload: {
        to: r.to,
        contract_evm: r.to,
        function_parameters: r.function_parameters ?? undefined,
        result: r.result,
        amount_tinybars: typeof r.amount === "number" ? r.amount : undefined,
      },
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────── row decoder ───────────────────────────────

function decodeRow(
  r: MirrorContractResult,
  syUsdPerShare: number | null,
): ActivityEntry | null {
  if (!r.to || !r.timestamp || !r.hash) return null;

  const to = r.to.toLowerCase() as `0x${string}`;
  const { label, abi } = lookupContract(to);

  const ts = Number(r.timestamp.split(".")[0]);

  // Default action: selector decoder fallback (covers HTS precompile + any
  // contract not in the registry). If we successfully decode below we
  // overwrite this.
  let action = decodeSelector(r.function_parameters);
  let amount: ActivityAmount | undefined;
  let side: "in" | "out" | undefined;

  if (abi && r.function_parameters && r.function_parameters !== "0x") {
    try {
      const decoded = decodeFunctionData({
        abi: abi as Abi,
        data: r.function_parameters as `0x${string}`,
      });
      const fnName = decoded.functionName;
      action = actionLabel(label, fnName);

      const primary = pickPrimaryArg(fnName, decoded.args as readonly unknown[], to);
      if (primary) {
        amount = makeAmount(primary, syUsdPerShare);
        side = primary.side;
      } else if (fnName === "zapHbarToSy" && typeof r.amount === "number" && r.amount > 0) {
        // Special case: zapHbarToSy carries the HBAR in via msg.value, not as a
        // calldata arg. Mirror Node's `amount` field is in tinybars (1 HBAR =
        // 1e8 tinybars).
        const raw = BigInt(r.amount);
        const hbarUsd = freshlyCached(hbarUsdCache) ?? null;
        const usd = hbarUsd !== null ? (Number(raw) / 1e8) * hbarUsd : undefined;
        amount = {
          token: "HBAR",
          raw: raw.toString(),
          formatted: formatTokenAmount(raw, 8),
          usd,
        };
        side = "out";
      }
    } catch {
      // viem couldn't decode — selector was in the contract's ABI namespace but
      // didn't match any function. Fall through with `action` already set to
      // `decodeSelector`'s output.
    }
  }

  const txId = r.hash;
  const hashscanUrl = `https://hashscan.io/mainnet/transaction/${txId}`;

  return {
    txId,
    timestamp: ts,
    contract: { address: to, id: r.contract_id, label },
    action,
    result: r.result ?? "UNKNOWN",
    amount,
    side,
    hashscanUrl,
  };
}

// ─────────────────────────────── amount formatting ───────────────────────────────

interface PrimaryArgResolved {
  raw: string;
  tokenAddress: `0x${string}` | null;
  tokenSymbol?: string;
  side: "in" | "out";
}

function makeAmount(
  primary: PrimaryArgResolved,
  syUsdPerShare: number | null,
): ActivityAmount {
  const info = lookupToken(primary.tokenAddress);
  const symbol = info?.symbol ?? primary.tokenSymbol ?? "—";
  const decimals = info?.decimals ?? 18;
  const raw = BigInt(primary.raw);
  const formatted = formatTokenAmount(raw, decimals);

  // USD only for SY share-denominated amounts. syUsdPerShare is in
  // $-per-raw-share-unit (matching the wagmi hook), so multiply by the raw
  // uint and trust the cent-level precision floor.
  let usd: number | undefined;
  if (info?.kind === "sy" && syUsdPerShare !== null) {
    usd = Number(raw) * syUsdPerShare;
  } else if (info?.kind === "usdc") {
    usd = Number(raw) / 1e6;
  }

  return { token: symbol, raw: raw.toString(), formatted, usd };
}

/**
 * Decimal-aware compact formatter for the activity row. Aims to render a tight
 * 6–10 character string that fits in the right-aligned amount column:
 *   0n             → "0"
 *   1n at dec=18   → "0.0000…01" (exponential)
 *   1e18 at dec=18 → "1.0000"
 *   1e24 at dec=18 → "1.00M"
 *   1e6 at dec=6   → "1.0000"  (USDC 1 dollar)
 *
 * The formatter divides by 10^decimals and switches to compact suffix once the
 * scaled value crosses 1e3 (matches `formatCompact` in `useMarkets.ts`).
 */
function formatTokenAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const div = 10n ** BigInt(decimals);
  const whole = raw / div;
  // Fractional part — we render up to 4 fractional digits, padded.
  const fracScale = 10n ** 4n;
  const frac = ((raw % div) * fracScale) / div;
  const fracStr = frac.toString().padStart(4, "0");

  if (whole >= 1_000_000_000_000n) return compactBig(whole, "T");
  if (whole >= 1_000_000_000n) return compactBig(whole, "B");
  if (whole >= 1_000_000n) return compactBig(whole, "M");
  if (whole >= 1_000n) return compactBig(whole, "K");

  if (whole > 0n) return `${whole.toString()}.${fracStr}`;

  // < 1 whole unit: show up to 6 fractional digits, or exponent for very small.
  const frac6 = ((raw % div) * 1_000_000n) / div;
  if (frac6 > 0n) return `0.${frac6.toString().padStart(6, "0")}`;
  // Smaller than 1e-6 — render the raw uint with exponent.
  const n = Number(raw) / Number(div);
  if (n > 0) return n.toExponential(2);
  return "0";
}

function compactBig(v: bigint, suffix: string): string {
  // For "K" suffix we divide by 1e3, etc. We render with 2 fractional digits.
  const divisors: Record<string, bigint> = {
    K: 1_000n,
    M: 1_000_000n,
    B: 1_000_000_000n,
    T: 1_000_000_000_000n,
  };
  const d = divisors[suffix];
  if (!d) return v.toString();
  const scaled = (v * 100n) / d;
  const whole = scaled / 100n;
  const frac = scaled % 100n;
  return `${whole.toString()}.${frac.toString().padStart(2, "0")}${suffix}`;
}

// ─────────────────────────────── SY USD price refresh ───────────────────────────────

/**
 * Recomputes USD per raw SY share for the live SaucerSwap V2 LP SY adapter.
 * Mirrors `useSyValueUsd` minus the React plumbing — five RPC reads (npm /
 * tokenId / token0 / token1 / poolFee / tickLower / tickUpper / shareToken,
 * then positions(tokenId) + pool.slot0 + shareToken.totalSupply) plus
 * CoinGecko for HBAR/USD.
 *
 * Failure mode: cache is set to `null` so callers know to omit USD until the
 * next refresh window. Never throws.
 */
async function refreshSyUsdPerShare(): Promise<void> {
  try {
    const syAddress = process.env.NEXT_PUBLIC_SY_SAUCER_V2_LP_ADDRESS as `0x${string}` | undefined;
    if (!syAddress) {
      syUsdPerShareCache = { value: null, ts: Date.now() };
      return;
    }

    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://mainnet.hashio.io/api";
    const client = createPublicClient({ chain: hederaMainnet, transport: http(rpcUrl) });

    const syPositionAbi = [
      { type: "function", name: "npm", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
      { type: "function", name: "positionTokenId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
      { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
      { type: "function", name: "poolFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
      { type: "function", name: "tickLower", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
      { type: "function", name: "tickUpper", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
    ] as const;

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

    const SAUCERSWAP_V2_FACTORY =
      "0x00000000000000000000000000000000003c3951" as const;
    const USDC_ADDR = "0x000000000000000000000000000000000006f89a" as const;
    const WHBAR_ADDR = "0x0000000000000000000000000000000000163b5a" as const;

    // 1) SY immutables.
    const [npm, tokenId, token0, token1, poolFee, tickLower, tickUpper, shareToken] =
      await Promise.all([
        client.readContract({ abi: syPositionAbi, address: syAddress, functionName: "npm" }),
        client.readContract({ abi: syPositionAbi, address: syAddress, functionName: "positionTokenId" }),
        client.readContract({ abi: syPositionAbi, address: syAddress, functionName: "token0" }),
        client.readContract({ abi: syPositionAbi, address: syAddress, functionName: "token1" }),
        client.readContract({ abi: syPositionAbi, address: syAddress, functionName: "poolFee" }),
        client.readContract({ abi: syPositionAbi, address: syAddress, functionName: "tickLower" }),
        client.readContract({ abi: syPositionAbi, address: syAddress, functionName: "tickUpper" }),
        client.readContract({ abi: syAbi, address: syAddress, functionName: "shareToken" }),
      ]);

    if (!tokenId || (tokenId as bigint) === 0n) {
      syUsdPerShareCache = { value: null, ts: Date.now() };
      return;
    }

    // 2) Pool address from the factory.
    const pool = (await client.readContract({
      abi: factoryGetPoolAbi,
      address: SAUCERSWAP_V2_FACTORY,
      functionName: "getPool",
      args: [token0 as `0x${string}`, token1 as `0x${string}`, poolFee as number],
    })) as `0x${string}`;

    // 3) Position + slot0 + shareToken totalSupply.
    const [positionTuple, slot0, totalSupplyShares] = await Promise.all([
      client.readContract({
        abi: npmPositionsAbi,
        address: npm as `0x${string}`,
        functionName: "positions",
        args: [tokenId as bigint],
      }),
      client.readContract({ abi: poolSlot0Abi, address: pool, functionName: "slot0" }),
      client.readContract({
        abi: erc20Abi,
        address: shareToken as `0x${string}`,
        functionName: "totalSupply",
      }),
    ]);

    const liquidity = (positionTuple as readonly unknown[])[5] as bigint;
    const sqrtP = (slot0 as readonly unknown[])[0] as bigint;
    const tSupplyShares = totalSupplyShares as bigint;

    if (liquidity === 0n || tSupplyShares === 0n) {
      syUsdPerShareCache = { value: 0, ts: Date.now() };
      return;
    }

    const { amount0, amount1 } = getAmountsForLiquidity(
      liquidity,
      sqrtP,
      tickLower as number,
      tickUpper as number,
    );

    // 4) HBAR/USD via CoinGecko (cached separately).
    const hbarUsd = await getHbarUsd();
    if (hbarUsd === null) {
      syUsdPerShareCache = { value: null, ts: Date.now() };
      return;
    }

    const t0 = (token0 as string).toLowerCase();
    const t1 = (token1 as string).toLowerCase();
    const valueSide = (addr: string, raw: bigint): number | undefined => {
      if (addr === USDC_ADDR.toLowerCase()) return Number(raw) / 1e6;
      if (addr === WHBAR_ADDR.toLowerCase()) return (Number(raw) / 1e8) * hbarUsd;
      return undefined;
    };
    const usd0 = valueSide(t0, amount0);
    const usd1 = valueSide(t1, amount1);
    if (usd0 === undefined || usd1 === undefined) {
      syUsdPerShareCache = { value: null, ts: Date.now() };
      return;
    }
    const totalLpUsd = usd0 + usd1;
    const usdPerShare = totalLpUsd / Number(tSupplyShares);
    syUsdPerShareCache = { value: usdPerShare, ts: Date.now() };
  } catch {
    // Fail-soft. The route still returns the entry envelope; USD just stays
    // undefined until the next request retries.
    syUsdPerShareCache = { value: null, ts: Date.now() };
  }
}

async function getHbarUsd(): Promise<number | null> {
  const cached = freshlyCached(hbarUsdCache);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd",
      { cache: "no-store" },
    );
    if (!res.ok) {
      hbarUsdCache = { value: null, ts: Date.now() };
      return null;
    }
    const json = (await res.json()) as { "hedera-hashgraph"?: { usd?: number } };
    const price = json["hedera-hashgraph"]?.usd;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      hbarUsdCache = { value: null, ts: Date.now() };
      return null;
    }
    hbarUsdCache = { value: price, ts: Date.now() };
    return price;
  } catch {
    hbarUsdCache = { value: null, ts: Date.now() };
    return null;
  }
}

// ─────────────────────────────── V3 math (ported from useSyValueUsd) ───────────────────────────────

const Q96 = 2n ** 96n;
const U256_MAX = (1n << 256n) - 1n;

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
  const shifted = ratio >> 32n;
  return ratio % (1n << 32n) === 0n ? shifted : shifted + 1n;
}

function getAmountsForLiquidity(
  liquidity: bigint,
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
): { amount0: bigint; amount1: bigint } {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];

  if (sqrtP <= lo) {
    const amount0 = (liquidity * Q96 * (hi - lo)) / (hi * lo);
    return { amount0, amount1: 0n };
  }
  if (sqrtP >= hi) {
    const amount1 = (liquidity * (hi - lo)) / Q96;
    return { amount0: 0n, amount1 };
  }
  const amount0 = (liquidity * Q96 * (hi - sqrtP)) / (hi * sqrtP);
  const amount1 = (liquidity * (sqrtP - lo)) / Q96;
  return { amount0, amount1 };
}
