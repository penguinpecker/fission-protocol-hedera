// POST /api/claim — redeem a marketing access code. Auth-gated (SIWE session).
//
// One claim per wallet, one wallet per code. The claim binds the code to the
// signed-in wallet's canonical address AND its resolved 0.0.x account id, so
// "eligible for the free mint" (claimed + >=1 on-chain tx) tracks correctly for
// BOTH wallet types — HashPack/Ed25519 (long-zero decodes directly) and
// MetaMask/ECDSA (mirror-resolved). The 0.0.x is the SAME identity key the XP +
// referral systems use; nothing here trusts a client-supplied address.
import { NextResponse, after, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountId, setUserAccountId } from "@/lib/referrals";
import { dripGas } from "@/lib/gas-drip";

export const dynamic = "force-dynamic";
// The after() drip (an on-chain HBAR transfer + receipt wait) runs in this same
// invocation post-response; give it room so it can't be killed mid-send.
export const maxDuration = 60;

// Seeded codes are 6-char unambiguous uppercase; accept that exact shape.
const CODE_RE = /^[A-Z0-9]{6}$/;

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const address = s.address.toLowerCase();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const raw = (body as { code?: unknown })?.code;
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!CODE_RE.test(code)) return NextResponse.json({ error: "invalid_code" }, { status: 400 });

  const supa = createServiceRoleClient();

  // Idempotent: a wallet that already claimed gets its existing code back (no
  // error), so re-submitting / revisiting never burns a second code.
  const { data: mine } = await supa
    .from("claim_codes")
    .select("code")
    .eq("claimed_by_address", address)
    .maybeSingle();
  if (mine) return NextResponse.json({ ok: true, code: mine.code, already: true });

  // Resolve the claimer's 0.0.x (both wallet types) + keep users.account_id fresh
  // — the single source claim_stats() reads for eligibility.
  const accountId = await resolveAccountId(address);
  await setUserAccountId(address, accountId);

  // Conditional claim — succeeds only if the code exists AND is still unclaimed.
  // The WHERE claimed=false guard makes concurrent redemptions of one code race-safe.
  const { data: claimed, error } = await supa
    .from("claim_codes")
    .update({
      claimed: true,
      claimed_by_address: address,
      claimed_by_account_id: accountId,
      claimed_at: new Date().toISOString(),
    })
    .eq("code", code)
    .eq("claimed", false)
    .select("code")
    .maybeSingle();

  if (error) {
    // 23505 = the one-per-wallet partial unique index: a concurrent claim by THIS
    // same wallet won the race. Surface their existing claim idempotently.
    if (error.code === "23505") {
      const { data: row } = await supa
        .from("claim_codes")
        .select("code")
        .eq("claimed_by_address", address)
        .maybeSingle();
      if (row) return NextResponse.json({ ok: true, code: row.code, already: true });
    }
    console.error("claim update failed", error.message);
    return NextResponse.json({ error: "claim_failed" }, { status: 500 });
  }

  if (!claimed) {
    // 0 rows updated → code doesn't exist, or was already taken by someone else.
    const { data: exists } = await supa
      .from("claim_codes")
      .select("claimed")
      .eq("code", code)
      .maybeSingle();
    if (!exists) return NextResponse.json({ error: "invalid_code" }, { status: 404 });
    return NextResponse.json({ error: "code_used" }, { status: 409 });
  }

  // Fire the starter-HBAR drip AFTER the response is sent — runs server-side,
  // independent of the browser, and doesn't slow the claim. No-op unless the
  // faucet is configured; idempotent + gated + budget-capped inside dripGas().
  after(() => dripGas(address));

  return NextResponse.json({ ok: true, code: claimed.code });
}
