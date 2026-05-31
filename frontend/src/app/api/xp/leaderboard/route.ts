// /api/xp/leaderboard — public GET. Paginated XP leaderboard.
//
// Source of truth is the `xp_leaderboard` view (xp_balances minus team/excluded
// wallets, pre-ranked). XP itself is derived ONLY from verified on-chain events
// (see the xp_* tables + recompute_xp()), so this endpoint can't be gamed from
// the client — it just reads a deterministic, server-computed aggregate.
//
//   GET /api/xp/leaderboard?page=1   → 50 rows/page, top 1000 users max.
//
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

const PAGE_SIZE = 50;
const MAX_RANK = 1000; // expose only the top 1000 users
const MAX_PAGE = MAX_RANK / PAGE_SIZE; // 20

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.min(Math.max(Number(searchParams.get("page") ?? 1) || 1, 1), MAX_PAGE);
  const offset = (page - 1) * PAGE_SIZE;

  let supa;
  try {
    supa = createServiceRoleClient();
  } catch {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  // Count first (cheap head query) so we never ask PostgREST for an
  // out-of-range slice — `.range(offset, …)` with offset >= rowcount throws
  // "range not satisfiable" (PGRST103). Past the last page we return an empty
  // set with 200 instead.
  const { count, error: countErr } = await supa
    .from("xp_leaderboard")
    .select("*", { count: "exact", head: true });

  if (countErr) {
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const total = Math.min(count ?? 0, MAX_RANK);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const headers = { "cache-control": "public, max-age=30, s-maxage=30" };

  if (offset >= total) {
    return NextResponse.json({ rows: [], page, pageSize: PAGE_SIZE, total, totalPages }, { headers });
  }

  const to = Math.min(offset + PAGE_SIZE - 1, MAX_RANK - 1);
  const { data, error } = await supa
    .from("xp_leaderboard")
    .select("rank,account_id,total_xp,level,action_count,last_event_at")
    .order("rank", { ascending: true })
    .range(offset, to);

  if (error) {
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const rows = (data ?? []).filter((r) => Number(r.rank) <= MAX_RANK);
  return NextResponse.json({ rows, page, pageSize: PAGE_SIZE, total, totalPages }, { headers });
}
