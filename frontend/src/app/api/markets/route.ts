// /api/markets — public read of the markets_cache. Rendered as JSON so the
// /markets page can server-render with cache data and skip per-page Hashio
// reads when the indexer is populated. Empty cache → empty array; the page
// falls back to on-chain reads via wagmi in that case.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { hederaMainnet } from "@/lib/chains";

export async function GET() {
  const supa = createServiceRoleClient();
  const { data, error } = await supa
    .from("markets_cache")
    .select(
      [
        "chain_id",
        "market_address",
        "market_type",
        "factory_address",
        "sy_address",
        "pt_address",
        "yt_address",
        "lp_address",
        "expiry",
        "scalar_root_e18",
        "total_pt",
        "total_sy_shares",
        "last_ln_implied_rate",
        "lp_total_supply",
        "initialized",
        "last_synced",
      ].join(","),
    )
    .eq("chain_id", hederaMainnet.id)
    .order("expiry", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ markets: data ?? [] });
}
