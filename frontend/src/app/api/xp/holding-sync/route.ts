// /api/xp/holding-sync — daily cron. Awards holding XP for capital held in the
// protocol over time: `usd_held × minutes_since_last_run × rate`.
//
// Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron sets it). Service-role
// writes only. Valuation is computed server-side from on-chain reads:
//   • SY usdPerShare — ported from useSyValueUsd (SaucerSwap-V2 LP basket: V3 tick
//     math on the SY's LP NFT, priced USDC=$1 + WHBAR via CoinGecko).
//   • PT/YT → SY    — authoritative Lens previews (previewSwapExact{Pt,Yt}ForSy).
//   • LP  → SY      — pool totals: (totalSy + totalPt·syPerPt) / lpSupply.
// Holders come from the mirror node token-balances; protocol contracts + the
// xp_excluded set are filtered out. Writes kind='holding' ledger rows, then
// recompute_xp() folds them into balances.

import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient, http } from "viem";
import { hederaMainnet } from "@/lib/chains";
import { syAbi, lensAbi } from "@/lib/abis";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/auth/timing-safe";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const SAUCERSWAP_V2_FACTORY = "0x00000000000000000000000000000000003c3951" as const;
// token0 = USDC (6 dec, $1 peg), token1 = WHBAR (8 dec) — fixed for this pool,
// same positional assumption as useSyValueUsd.
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd";

// Protocol contracts whose token balances are reserves, not user holdings.
const PROTOCOL_EXCLUDE = new Set<string>([
  "0.0.10502053", // market (AMM reserves)
  "0.0.10502061", // periphery
  "0.0.10502045", // SY adapter (holds the LP NFT)
]);
const PROBE = 10_000_000n; // marginal-rate probe size (raw PT/YT)
const MAX_ELAPSED_MIN = 1500; // cap accrual if the cron was down (avoid huge credit)
const DEFAULT_FIRST_MIN = 1440; // first-ever run credits one day

// ── V3 math (verbatim port of useSyValueUsd) ──────────────────────────────────
const Q96 = 2n ** 96n;
const U256_MAX = (1n << 256n) - 1n;
function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = tick < 0 ? -tick : tick;
  let ratio =
    (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
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
function getAmountsForLiquidity(liquidity: bigint, sqrtP: bigint, tickLower: number, tickUpper: number) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (sqrtP <= lo) return { amount0: (liquidity * Q96 * (hi - lo)) / (hi * lo), amount1: 0n };
  if (sqrtP >= hi) return { amount0: 0n, amount1: (liquidity * (hi - lo)) / Q96 };
  return {
    amount0: (liquidity * Q96 * (hi - sqrtP)) / (hi * sqrtP),
    amount1: (liquidity * (sqrtP - lo)) / Q96,
  };
}

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
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" }, { name: "liquidity", type: "uint128" },
      { name: "f0", type: "uint256" }, { name: "f1", type: "uint256" }, { name: "o0", type: "uint128" }, { name: "o1", type: "uint128" },
    ] },
] as const;
const factoryGetPoolAbi = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }, { name: "b", type: "address" }, { name: "fee", type: "uint24" }],
    outputs: [{ type: "address" }] },
] as const;
const poolSlot0Abi = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "oi", type: "uint16" },
      { name: "oc", type: "uint16" }, { name: "ocn", type: "uint16" }, { name: "fp", type: "uint8" }, { name: "unlocked", type: "bool" },
    ] },
] as const;

function evmToHederaId(evm: string): string {
  const h = evm.replace(/^0x/, "").toLowerCase();
  return "0.0." + parseInt(h.slice(-16), 16);
}

async function fetchHbarUsd(): Promise<number | null> {
  try {
    const r = await fetch(COINGECKO_URL, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { "hedera-hashgraph"?: { usd?: number } };
    const p = j["hedera-hashgraph"]?.usd;
    return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

// Enumerate all holders of an HTS token (mirror node, paginated). 0 balances skipped.
async function tokenHolders(tokenId: string): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  let url: string | null = `${MIRROR}/api/v1/tokens/${tokenId}/balances?limit=100`;
  let guard = 0;
  while (url && guard++ < 50) {
    const r: Response = await fetch(url, { cache: "no-store" });
    if (!r.ok) break;
    const j = (await r.json()) as { balances?: { account: string; balance: number }[]; links?: { next?: string } };
    for (const b of j.balances ?? []) {
      if (b.balance > 0) out.set(b.account, BigInt(b.balance));
    }
    const next = j.links?.next;
    url = next ? `${MIRROR}${next}` : null;
  }
  return out;
}

type Client = ReturnType<typeof createPublicClient>;
async function read<T>(client: Client, address: `0x${string}`, abi: readonly unknown[], fn: string, args: unknown[] = []): Promise<T | null> {
  try {
    return (await client.readContract({ abi: abi as never, address, functionName: fn, args })) as T;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    return await run(req);
  } catch (e) {
    return NextResponse.json({ error: "holding_sync_failed", message: e instanceof Error ? e.message : "unknown" }, { status: 500 });
  }
}
export const POST = GET;

async function run(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return NextResponse.json({ error: "cron_secret_unset" }, { status: 500 });
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${expected}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://mainnet.hashio.io/api";
  if (!isDeployed(ADDRESSES.factory)) return NextResponse.json({ error: "factory_not_deployed" }, { status: 412 });

  const client = createPublicClient({ chain: hederaMainnet, transport: http(rpcUrl) });
  const supa = createServiceRoleClient();

  // rate + exclusions
  const { data: rateRow } = await supa.from("xp_params").select("num").eq("key", "holding_xp_per_usd_per_min").maybeSingle();
  const rate = Number(rateRow?.num ?? 1);
  const { data: exRows } = await supa.from("xp_excluded").select("account_id");
  const exclude = new Set<string>([...PROTOCOL_EXCLUDE, ...(exRows ?? []).map((r) => r.account_id)]);

  // elapsed minutes since last run
  const { data: lastRun } = await supa.from("xp_holding_runs").select("run_at").order("run_at", { ascending: false }).limit(1).maybeSingle();
  const nowMs = Date.now();
  const prevAt = lastRun?.run_at ? new Date(lastRun.run_at).getTime() : null;
  const elapsedMin = prevAt ? Math.min((nowMs - prevAt) / 60000, MAX_ELAPSED_MIN) : DEFAULT_FIRST_MIN;
  if (elapsedMin <= 0) return NextResponse.json({ skipped: "no_elapsed" });

  const hbarUsd = await fetchHbarUsd();

  // live, initialized, non-archived markets
  const { data: markets } = await supa
    .from("markets_cache")
    .select("market_address,sy_address,pt_address,yt_address,lp_address,total_sy_shares,total_pt,lp_total_supply")
    .eq("chain_id", hederaMainnet.id)
    .eq("is_archived", false)
    .eq("initialized", true);

  const heldUsd = new Map<string, number>(); // account_id -> USD across all markets
  const marketsValued: Record<string, unknown> = {};

  for (const m of markets ?? []) {
    const market = m.market_address as `0x${string}`;
    const syAdapter = m.sy_address as `0x${string}`;

    // --- usdPerShare (V3 basket) ---
    const npm = await read<`0x${string}`>(client, syAdapter, syPositionAbi, "npm");
    const tokenId = await read<bigint>(client, syAdapter, syPositionAbi, "positionTokenId");
    const t0 = await read<`0x${string}`>(client, syAdapter, syPositionAbi, "token0");
    const t1 = await read<`0x${string}`>(client, syAdapter, syPositionAbi, "token1");
    const fee = await read<number>(client, syAdapter, syPositionAbi, "poolFee");
    const tickLower = await read<number>(client, syAdapter, syPositionAbi, "tickLower");
    const tickUpper = await read<number>(client, syAdapter, syPositionAbi, "tickUpper");
    const shareToken = await read<`0x${string}`>(client, syAdapter, syAbi, "shareToken");

    let usdPerShare: number | null = null;
    if (npm && tokenId && tokenId > 0n && t0 && t1 && fee != null && tickLower != null && tickUpper != null && hbarUsd) {
      const pos = await read<readonly unknown[]>(client, npm, npmPositionsAbi, "positions", [tokenId]);
      const liquidity = pos ? (pos[5] as bigint) : null;
      const pool = await read<`0x${string}`>(client, SAUCERSWAP_V2_FACTORY, factoryGetPoolAbi, "getPool", [t0, t1, fee]);
      const slot0 = pool ? await read<readonly unknown[]>(client, pool, poolSlot0Abi, "slot0") : null;
      const sqrtP = slot0 ? (slot0[0] as bigint) : null;
      if (liquidity && liquidity > 0n && sqrtP) {
        const { amount0, amount1 } = getAmountsForLiquidity(liquidity, sqrtP, tickLower, tickUpper);
        // token0 = USDC (6 dec, $1), token1 = WHBAR (8 dec)
        const usdcUsd = Number(amount0) / 1e6;
        const whbarUsd = (Number(amount1) / 1e8) * hbarUsd;
        const totalLpUsd = usdcUsd + whbarUsd;
        usdPerShare = totalLpUsd / Number(liquidity);
      }
    }
    if (!usdPerShare || !Number.isFinite(usdPerShare)) continue; // can't value this market

    // --- PT/YT -> SY (Lens), LP -> SY (pool totals) ---
    const ptSyOut = await read<bigint>(client, ADDRESSES.lens, lensAbi, "previewSwapExactPtForSy", [market, PROBE]);
    const syPerPt = ptSyOut != null ? Number(ptSyOut) / Number(PROBE) : 0;
    const ytRes = await read<readonly bigint[]>(client, ADDRESSES.lens, lensAbi, "previewSwapExactYtForSy", [market, PROBE]);
    const syPerYt = ytRes && ytRes[0] != null ? Number(ytRes[0]) / Number(PROBE) : 0;

    const totalSy = Number(m.total_sy_shares ?? 0);
    const totalPt = Number(m.total_pt ?? 0);
    const lpSupply = Number(m.lp_total_supply ?? 0);
    const syPerLp = lpSupply > 0 ? (totalSy + totalPt * syPerPt) / lpSupply : 0;

    const usdPerSy = usdPerShare;
    const usdPerPt = syPerPt * usdPerShare;
    const usdPerYt = syPerYt * usdPerShare;
    const usdPerLp = syPerLp * usdPerShare;

    // --- holders ---
    const [syH, ptH, ytH, lpH] = await Promise.all([
      shareToken ? tokenHolders(evmToHederaId(shareToken)) : Promise.resolve(new Map<string, bigint>()),
      m.pt_address ? tokenHolders(evmToHederaId(m.pt_address)) : Promise.resolve(new Map<string, bigint>()),
      m.yt_address ? tokenHolders(evmToHederaId(m.yt_address)) : Promise.resolve(new Map<string, bigint>()),
      m.lp_address ? tokenHolders(evmToHederaId(m.lp_address)) : Promise.resolve(new Map<string, bigint>()),
    ]);
    const accounts = new Set<string>([...syH.keys(), ...ptH.keys(), ...ytH.keys(), ...lpH.keys()]);
    let valued = 0;
    for (const acct of accounts) {
      if (exclude.has(acct)) continue;
      const usd =
        Number(syH.get(acct) ?? 0n) * usdPerSy +
        Number(lpH.get(acct) ?? 0n) * usdPerLp +
        Number(ptH.get(acct) ?? 0n) * usdPerPt +
        Number(ytH.get(acct) ?? 0n) * usdPerYt;
      if (usd > 0) {
        heldUsd.set(acct, (heldUsd.get(acct) ?? 0) + usd);
        valued++;
      }
    }
    marketsValued[market] = { usdPerShare, syPerPt, syPerYt, syPerLp, holders: valued };
  }

  // --- record run + write holding ledger rows ---
  const totalUsd = [...heldUsd.values()].reduce((a, b) => a + b, 0);
  const { data: runRow, error: runErr } = await supa
    .from("xp_holding_runs")
    .insert({
      run_at: new Date(nowMs).toISOString(),
      prev_run_at: prevAt ? new Date(prevAt).toISOString() : null,
      minutes_elapsed: elapsedMin,
      rate,
      holders: heldUsd.size,
      total_usd: totalUsd,
    })
    .select("id")
    .single();
  if (runErr || !runRow) return NextResponse.json({ error: "run_insert_failed", message: runErr?.message }, { status: 500 });

  const runId = runRow.id as number;
  let awarded = 0;
  const ledgerRows = [...heldUsd.entries()]
    .map(([account_id, usd]) => {
      const points = Math.round(usd * elapsedMin * rate);
      awarded += points;
      return { account_id, kind: "holding" as const, ref: `hold:${runId}`, event_type: null, points, usd_value: usd, block_timestamp: new Date(nowMs).toISOString() };
    })
    .filter((r) => r.points > 0);

  if (ledgerRows.length > 0) {
    const { error: insErr } = await supa.from("xp_ledger").insert(ledgerRows);
    if (insErr) return NextResponse.json({ error: "ledger_insert_failed", message: insErr.message }, { status: 500 });
  }
  await supa.from("xp_holding_runs").update({ total_xp_awarded: awarded }).eq("id", runId);

  // fold holding XP into balances
  await supa.rpc("recompute_xp");

  return NextResponse.json({
    runId,
    elapsedMin: Math.round(elapsedMin),
    rate,
    holders: heldUsd.size,
    totalUsd: Number(totalUsd.toFixed(6)),
    xpAwarded: awarded,
    markets: marketsValued,
    syncedAt: new Date(nowMs).toISOString(),
  });
}
