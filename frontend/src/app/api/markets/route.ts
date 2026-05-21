// /api/markets — public read of the markets_cache. Rendered as JSON so the
// /markets page can server-render with cache data and skip per-page Hashio
// reads when the indexer is populated. Empty cache → empty array; the page
// falls back to on-chain reads via wagmi in that case.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { hederaMainnet } from "@/lib/chains";

export async function GET(req: Request) {
  // ?includeArchived=1 returns archived markets too (default: active only).
  // Default callers — the /markets page list, the watchlist — get active markets;
  // history / position pages can opt in to see archived entries.
  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("includeArchived") === "1";

  const supa = createServiceRoleClient();
  let q = supa
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
        "is_archived",
        "archived_reason",
        "archived_at",
      ].join(","),
    )
    .eq("chain_id", hederaMainnet.id);
  if (!includeArchived) q = q.eq("is_archived", false);
  const { data, error } = await q.order("expiry", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ markets: data ?? [] });
}
