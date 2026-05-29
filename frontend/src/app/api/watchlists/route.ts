// /api/watchlists — read or mutate the current user's market watchlist.
//
// Same pattern as /api/profile: session cookie validated server-side, address
// pulled from the cookie (never from the body), service-role Supabase client
// used so RLS isn't in the request path.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/server";

const ItemSchema = z.object({
  chain_id: z.number().int().positive(),
  market_address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .transform((s) => s.toLowerCase()),
});

export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const supa = createServiceRoleClient();
  const { data, error } = await supa
    .from("watchlists")
    .select("chain_id, market_address, added_at")
    .eq("address", s.address)
    .order("added_at", { ascending: false });
  if (error) {
    // WEB2-04: opaque code out, detail to server logs only.
    console.error("watchlists GET db_error", error.message);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  return NextResponse.json({ watchlist: data ?? [] });
}

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = ItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  }

  const supa = createServiceRoleClient();
  // Watchlists FK to users(address); ensure the user row exists before inserting.
  await supa.from("users").upsert({ address: s.address }, { onConflict: "address" });

  const { error } = await supa.from("watchlists").upsert(
    {
      address: s.address,
      chain_id: parsed.data.chain_id,
      market_address: parsed.data.market_address,
    },
    { onConflict: "address,chain_id,market_address" },
  );
  if (error) {
    console.error("watchlists POST db_error", error.message);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const url = new URL(req.url);
  const chainId = Number(url.searchParams.get("chain_id"));
  const marketAddress = url.searchParams.get("market_address");
  if (
    !Number.isInteger(chainId) ||
    chainId <= 0 ||
    !marketAddress ||
    !/^0x[a-fA-F0-9]{40}$/.test(marketAddress)
  ) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  const supa = createServiceRoleClient();
  const { error } = await supa
    .from("watchlists")
    .delete()
    .eq("address", s.address)
    .eq("chain_id", chainId)
    .eq("market_address", marketAddress.toLowerCase());
  if (error) {
    console.error("watchlists DELETE db_error", error.message);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
