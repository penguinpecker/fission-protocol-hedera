// /api/markets/refresh — POST (cron / on-demand) to rebuild markets_cache from
// the chain. Read factory.marketCount + getMarkets, then multicall each market
// for sy/pt/yt/lp/expiry/scalarRoot/totalSy/totalPt/lastLnImpliedRate, classify
// market_type by matching the SY address against the v1 rewards-SY allowlist,
// and upsert into Supabase.
//
// Auth: requires `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron sets this
// header automatically). In dev, set CRON_SECRET locally to call manually.

import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient, http } from "viem";
import { hederaMainnet } from "@/lib/chains";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { factoryAbi, marketAbi, erc20Abi } from "@/lib/abis";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/auth/timing-safe";

// Rewards-bearing SY adapters. The current live one + every retired one so
// historical market records resolve correctly. Update when adding new ones.
const REWARDS_SY_ADDRESSES = new Set<string>(
  [
    process.env.NEXT_PUBLIC_SY_SAUCER_V2_LP_ADDRESS,
    process.env.NEXT_PUBLIC_SY_ADDRESS,
    "0x0000000000000000000000000000000000a03f9d", // 2026-05-29 SY (UUPS-proxy rebuild, live)
    "0x0000000000000000000000000000000000a0289a", // 2026-05-29 pre-proxy SY (archived)
    "0x0000000000000000000000000000000000a02585", // 2026-05-27 SY v1 (archived)
    "0x00000000000000000000000000000000009fb089", // legacy
  ]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.toLowerCase()),
);

export async function POST(req: NextRequest) {
  try {
    return await refreshMarketsCache(req);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ error: "refresh_failed", message }, { status: 500 });
  }
}

async function refreshMarketsCache(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "cron_secret_unset" }, { status: 500 });
  }
  // WEB2-CRON-04: constant-time compare to avoid leaking the secret via timing.
  if (!timingSafeEqualStr(auth ?? "", `Bearer ${expected}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isDeployed(ADDRESSES.factory)) {
    return NextResponse.json({ error: "factory_not_deployed" }, { status: 412 });
  }

  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
  if (!rpcUrl) {
    return NextResponse.json({ error: "rpc_url_unset" }, { status: 500 });
  }

  const client = createPublicClient({ chain: hederaMainnet, transport: http(rpcUrl) });

  const count = (await client.readContract({
    abi: factoryAbi,
    address: ADDRESSES.factory,
    functionName: "marketCount",
  })) as bigint;

  if (count === 0n) {
    return NextResponse.json({ refreshed: 0, count: 0 });
  }

  const addresses = (await client.readContract({
    abi: factoryAbi,
    address: ADDRESSES.factory,
    functionName: "getMarkets",
    args: [0n, count],
  })) as readonly `0x${string}`[];

  // Hedera's HTS-flavored EVM doesn't deploy Multicall3 at the canonical address,
  // so use parallel readContract calls instead. Per-market reads run in parallel
  // (Promise.all), markets fan out across Promise.all too — fine for v1's small N.
  type SettledOk<T> = { status: "success"; result: T };
  type SettledErr = { status: "failure" };
  type Settled<T> = SettledOk<T> | SettledErr;

  async function readOrFail<T>(
    address: `0x${string}`,
    abi: readonly unknown[],
    fn: string,
  ): Promise<Settled<T>> {
    try {
      const result = (await client.readContract({
        abi: abi as never,
        address,
        functionName: fn,
      })) as T;
      return { status: "success", result };
    } catch {
      return { status: "failure" };
    }
  }

  const perMarket = await Promise.all(
    addresses.map(async (addr) => {
      const [sy, pt, yt, lp, expiry, scalarRoot, totalSy, totalPt, lastLn] = await Promise.all([
        readOrFail<`0x${string}`>(addr, marketAbi, "sy"),
        readOrFail<`0x${string}`>(addr, marketAbi, "pt"),
        readOrFail<`0x${string}`>(addr, marketAbi, "yt"),
        readOrFail<`0x${string}`>(addr, marketAbi, "lp"),
        readOrFail<bigint>(addr, marketAbi, "expiry"),
        readOrFail<bigint>(addr, marketAbi, "scalarRoot"),
        readOrFail<bigint>(addr, marketAbi, "totalSy"),
        readOrFail<bigint>(addr, marketAbi, "totalPt"),
        readOrFail<bigint>(addr, marketAbi, "lastLnImpliedRate"),
      ]);
      let lpSupply: bigint | null = null;
      if (lp.status === "success") {
        const supply = await readOrFail<bigint>(lp.result, erc20Abi, "totalSupply");
        if (supply.status === "success") lpSupply = supply.result;
      }
      return { addr, sy, pt, yt, lp, expiry, scalarRoot, totalSy, totalPt, lastLn, lpSupply };
    }),
  );

  const ok = <T>(r: Settled<T>): r is SettledOk<T> => r.status === "success";

  const supa = createServiceRoleClient();
  const rows: Array<{
    chain_id: number;
    market_address: string;
    market_type: "standard" | "rewards";
    factory_address: string;
    sy_address: string;
    pt_address: string | null;
    yt_address: string | null;
    lp_address: string | null;
    expiry: string | null;
    scalar_root_e18: string | null;
    total_pt: string | null;
    total_sy_shares: string | null;
    last_ln_implied_rate: string | null;
    lp_total_supply: string | null;
    initialized: boolean;
    is_archived: boolean;
    last_synced: string;
  }> = [];

  for (const m of perMarket) {
    if (!ok(m.sy)) continue;
    const syAddr = m.sy.result.toLowerCase();
    const lastLnVal = ok(m.lastLn) ? m.lastLn.result : 0n;

    rows.push({
      chain_id: hederaMainnet.id,
      market_address: m.addr.toLowerCase(),
      market_type: REWARDS_SY_ADDRESSES.has(syAddr) ? "rewards" : "standard",
      factory_address: ADDRESSES.factory.toLowerCase(),
      sy_address: syAddr,
      pt_address: ok(m.pt) ? m.pt.result.toLowerCase() : null,
      yt_address: ok(m.yt) ? m.yt.result.toLowerCase() : null,
      lp_address: ok(m.lp) ? m.lp.result.toLowerCase() : null,
      expiry: ok(m.expiry) ? new Date(Number(m.expiry.result) * 1000).toISOString() : null,
      scalar_root_e18: ok(m.scalarRoot) ? m.scalarRoot.result.toString() : null,
      total_pt: ok(m.totalPt) ? m.totalPt.result.toString() : null,
      total_sy_shares: ok(m.totalSy) ? m.totalSy.result.toString() : null,
      last_ln_implied_rate: lastLnVal.toString(),
      lp_total_supply: m.lpSupply !== null ? m.lpSupply.toString() : null,
      initialized: lastLnVal !== 0n,
      is_archived: false,
      last_synced: new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    const { error } = await supa
      .from("markets_cache")
      .upsert(rows, { onConflict: "chain_id,market_address" });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    // DL-1: archive any cached market from a PRIOR factory so the UI never
    // shows a superseded market as active alongside the canonical one. Gated
    // on rows.length>0 (the enclosing if) so an RPC blip that returns zero
    // current markets can't mass-archive the live set.
    await supa
      .from("markets_cache")
      .update({ is_archived: true })
      .eq("chain_id", hederaMainnet.id)
      .neq("factory_address", ADDRESSES.factory.toLowerCase())
      .eq("is_archived", false);
  }

  return NextResponse.json({
    refreshed: rows.length,
    count: Number(count),
    syncedAt: new Date().toISOString(),
  });
}

// Also accept GET so Vercel Cron's default GET-based scheduler works.
export const GET = POST;
