// /api/markets/refresh — POST (cron / on-demand) to rebuild markets_cache from
// the chain. Read factory.marketCount + getMarkets, then multicall each market
// for sy/pt/yt/lp/expiry/scalarRoot/totalSy/totalPt/lastLnImpliedRate, classify
// market_type by matching the SY address against the v1 rewards-SY allowlist,
// and upsert into Supabase.
//
// Auth: requires `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron sets this
// header automatically). In dev, set CRON_SECRET locally to call manually.

import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";
import { hederaMainnet } from "@/lib/chains";
import { ADDRESSES, isDeployed } from "@/lib/addresses";
import { factoryAbi, marketAbi, erc20Abi, syAbi } from "@/lib/abis";
import { createServiceRoleClient } from "@/lib/supabase/server";

// v1 lineup — update when adding new rewards-bearing SY adapters.
const REWARDS_SY_ADDRESSES = new Set<string>(
  [
    process.env.NEXT_PUBLIC_SY_SAUCER_V2_LP_ADDRESS,
    "0x00000000000000000000000000000000009fb089",
  ]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.toLowerCase()),
);

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "cron_secret_unset" }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
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

  const reads = addresses.flatMap((address) => [
    { abi: marketAbi, address, functionName: "sy" } as const,
    { abi: marketAbi, address, functionName: "pt" } as const,
    { abi: marketAbi, address, functionName: "yt" } as const,
    { abi: marketAbi, address, functionName: "lp" } as const,
    { abi: marketAbi, address, functionName: "expiry" } as const,
    { abi: marketAbi, address, functionName: "scalarRoot" } as const,
    { abi: marketAbi, address, functionName: "totalSy" } as const,
    { abi: marketAbi, address, functionName: "totalPt" } as const,
    { abi: marketAbi, address, functionName: "lastLnImpliedRate" } as const,
  ]);

  const results = await client.multicall({ contracts: reads, allowFailure: true });

  type R = (typeof results)[number];
  const lpReads = addresses.flatMap((_, i) => {
    const lp = results[i * 9 + 3] as R | undefined;
    if (!lp || lp.status !== "success" || !lp.result) return [];
    return [
      { abi: erc20Abi, address: lp.result as `0x${string}`, functionName: "totalSupply" } as const,
    ];
  });
  const lpSupplies =
    lpReads.length > 0
      ? await client.multicall({ contracts: lpReads, allowFailure: true })
      : [];

  const ok = (r: R | undefined): r is Extract<R, { status: "success" }> =>
    r?.status === "success";

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
    last_synced: string;
  }> = [];

  let lpIdx = 0;
  for (let i = 0; i < addresses.length; i++) {
    const marketAddr = addresses[i];
    if (!marketAddr) continue;

    const base = i * 9;
    const sy = results[base];
    const pt = results[base + 1];
    const yt = results[base + 2];
    const lp = results[base + 3];
    const expiry = results[base + 4];
    const scalarRoot = results[base + 5];
    const totalSy = results[base + 6];
    const totalPt = results[base + 7];
    const lastLn = results[base + 8];

    if (!ok(sy)) continue;
    const syAddr = (sy.result as string).toLowerCase();

    let lpSupply: bigint | null = null;
    if (ok(lp) && lp.result) {
      const supply = lpSupplies[lpIdx++];
      if (ok(supply)) lpSupply = supply.result as bigint;
    }

    const lastLnVal = ok(lastLn) ? (lastLn.result as bigint) : 0n;

    rows.push({
      chain_id: hederaMainnet.id,
      market_address: marketAddr.toLowerCase(),
      market_type: REWARDS_SY_ADDRESSES.has(syAddr) ? "rewards" : "standard",
      factory_address: ADDRESSES.factory.toLowerCase(),
      sy_address: syAddr,
      pt_address: ok(pt) ? (pt.result as string).toLowerCase() : null,
      yt_address: ok(yt) ? (yt.result as string).toLowerCase() : null,
      lp_address: ok(lp) ? (lp.result as string).toLowerCase() : null,
      expiry: ok(expiry) ? new Date(Number(expiry.result as bigint) * 1000).toISOString() : null,
      scalar_root_e18: ok(scalarRoot) ? (scalarRoot.result as bigint).toString() : null,
      total_pt: ok(totalPt) ? (totalPt.result as bigint).toString() : null,
      total_sy_shares: ok(totalSy) ? (totalSy.result as bigint).toString() : null,
      last_ln_implied_rate: lastLnVal.toString(),
      lp_total_supply: lpSupply !== null ? lpSupply.toString() : null,
      initialized: lastLnVal !== 0n,
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
  }

  return NextResponse.json({
    refreshed: rows.length,
    count: Number(count),
    syncedAt: new Date().toISOString(),
  });
}

// Also accept GET so Vercel Cron's default GET-based scheduler works.
export const GET = POST;
