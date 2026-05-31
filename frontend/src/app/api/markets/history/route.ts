// /api/markets/history — public GET. Returns the recorded apy_snapshots
// time-series for a market (implied APY + pool depth over time) for charting.
// markets_cache only holds the latest value; this exposes the persisted history
// written by the refresh-route heartbeat + the cron-apy poller.
//
// No auth: apy_snapshots is anon-readable via RLS (public charting data).
//
//   GET /api/markets/history?market=0x..&limit=500&since=2026-05-30T00:00:00Z
//
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { hederaMainnet } from "@/lib/chains";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const market = (searchParams.get("market") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(market)) {
    return NextResponse.json({ error: "invalid_market" }, { status: 400 });
  }

  const chainId = Number(searchParams.get("chainId") ?? hederaMainnet.id);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: "invalid_chain" }, { status: 400 });
  }

  // Clamp limit to a sane window (default 500, max 5000 rows).
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 500) || 500, 1), 5000);
  const since = searchParams.get("since"); // optional ISO timestamp lower bound

  const supa = createServiceRoleClient();
  let q = supa
    .from("apy_snapshots")
    .select(
      "captured_at,implied_apy_pct,last_ln_implied_rate,total_sy,total_pt,lp_total_supply,source,tx_hash",
    )
    .eq("chain_id", chainId)
    .eq("market_address", market)
    .order("captured_at", { ascending: false })
    .limit(limit);

  if (since) {
    const ts = new Date(since);
    if (Number.isNaN(ts.getTime())) {
      return NextResponse.json({ error: "invalid_since" }, { status: 400 });
    }
    q = q.gte("captured_at", ts.toISOString());
  }

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    market,
    chainId,
    count: data?.length ?? 0,
    // Newest-first from the query; reverse to chronological for charting.
    snapshots: (data ?? []).slice().reverse(),
  });
}
