// /api/referrals/me — the signed-in user's referral link + stats. Auth-gated.
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { ensureReferralCode, resolveAccountId } from "@/lib/referrals";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const address = s.address.toLowerCase();
  const supa = createServiceRoleClient();

  // Resolve (or lazily create) this user's code — covers the rare case where
  // the verify-route hook hadn't run yet for them.
  const { data: codeRow } = await supa
    .from("referral_codes")
    .select("code")
    .eq("owner_address", address)
    .maybeSingle();
  const code = codeRow?.code ?? (await ensureReferralCode(address, await resolveAccountId(address)));

  const { data: stats } = await supa.rpc("referral_stats", { p_address: address });
  const row = Array.isArray(stats) ? stats[0] : stats;

  return NextResponse.json(
    {
      code,
      link: code ? `https://www.fissionp.com/ref?r=${code}` : null,
      totalSignups: Number(row?.total_signups ?? 0),
      signupsWithTx: Number(row?.signups_with_tx ?? 0),
      referralXp: Number(row?.referral_xp ?? 0),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
