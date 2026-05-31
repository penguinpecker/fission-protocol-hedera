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

  const [{ data: stats }, { data: list }] = await Promise.all([
    supa.rpc("referral_stats", { p_address: address }),
    supa.rpc("referral_list", { p_address: address }),
  ]);
  const row = Array.isArray(stats) ? stats[0] : stats;

  type ListRow = { referee_address: string; code: string; signed_up_at: string; transacted: boolean };
  const referrals = ((list ?? []) as ListRow[]).map((r) => ({
    referee: r.referee_address,
    code: r.code,
    signedUpAt: r.signed_up_at,
    transacted: Boolean(r.transacted),
  }));

  return NextResponse.json(
    {
      code,
      link: code ? `https://www.fissionp.com/ref?r=${code}` : null,
      totalSignups: Number(row?.total_signups ?? 0),
      signupsWithTx: Number(row?.signups_with_tx ?? 0),
      referralXp: Number(row?.referral_xp ?? 0),
      referrals,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
