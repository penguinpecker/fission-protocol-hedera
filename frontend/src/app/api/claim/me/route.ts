// GET /api/claim/me — the signed-in wallet's claim status. Auth-gated.
//
// Returns { claimed, code, eligible }. `eligible` = claimed AND the claimer's
// 0.0.x has >=1 successful on-chain action. If the account id wasn't resolvable
// at claim time (brand-new ECDSA wallet), we lazily backfill it here so
// eligibility starts tracking the moment the account exists — same fresh-source
// pattern as the referral fix, so neither wallet type is dropped.
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountId, setUserAccountId, accountHasTx } from "@/lib/referrals";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const address = s.address.toLowerCase();
  const supa = createServiceRoleClient();

  const { data: mine } = await supa
    .from("claim_codes")
    .select("code, claimed_by_account_id")
    .eq("claimed_by_address", address)
    .maybeSingle();

  if (!mine) {
    return NextResponse.json(
      { claimed: false, code: null, eligible: false },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  // Lazily resolve + backfill the 0.0.x if it was null at claim time.
  let accountId = mine.claimed_by_account_id as string | null;
  if (!accountId) {
    accountId = await resolveAccountId(address);
    if (accountId) {
      await setUserAccountId(address, accountId);
      await supa
        .from("claim_codes")
        .update({ claimed_by_account_id: accountId })
        .eq("claimed_by_address", address)
        .is("claimed_by_account_id", null);
    }
  }

  const eligible = await accountHasTx(accountId);
  return NextResponse.json(
    { claimed: true, code: mine.code, eligible },
    { headers: { "cache-control": "private, no-store" } },
  );
}
