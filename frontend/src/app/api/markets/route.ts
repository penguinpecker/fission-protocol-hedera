// /api/markets — public read of the markets_cache. Rendered as JSON so the
// /markets page can server-render with cache data and skip per-page Hashio
// reads when the indexer is populated. Empty cache → empty array; the page
// falls back to on-chain reads via wagmi in that case.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { hederaMainnet } from "@/lib/chains";

export async function GET(req: Request) {
  // ?includeArchived=(1|true|yes|on) returns archived markets too (default: active only).
  // Default callers — the /markets page list, the watchlist — get active markets;
  // history / position pages can opt in to see archived entries.
  const url = new URL(req.url);
  const includeArchivedRaw = (url.searchParams.get("includeArchived") ?? "").toLowerCase();
  const includeArchived = ["1", "true", "yes", "on"].includes(includeArchivedRaw);

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
  if (error) {
    // WEB2-04: opaque code out, detail to server logs only.
    console.error("markets GET db_error", error.message);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  // LP-3: numeric(78,0) columns whose magnitude can exceed Number.MAX_SAFE_INTEGER
  // (2^53) must serialize as strings, or JSON.stringify rounds them. supabase-js
  // already returns numeric as text, but coerce defensively so the contract is
  // explicit and stable regardless of driver behavior.
  const markets = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((m) => ({
    ...m,
    scalar_root_e18: m.scalar_root_e18 == null ? null : String(m.scalar_root_e18),
    total_pt: m.total_pt == null ? null : String(m.total_pt),
    total_sy_shares: m.total_sy_shares == null ? null : String(m.total_sy_shares),
    last_ln_implied_rate: m.last_ln_implied_rate == null ? null : String(m.last_ln_implied_rate),
    lp_total_supply: m.lp_total_supply == null ? null : String(m.lp_total_supply),
  }));
  return NextResponse.json({ markets });
}
