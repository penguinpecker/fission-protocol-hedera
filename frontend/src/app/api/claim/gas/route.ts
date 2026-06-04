// POST /api/claim/gas — send the one-time starter HBAR to the signed-in wallet.
// Auth-gated, idempotent, gated + budget-capped inside dripGas(). The primary
// trigger is `after()` in POST /api/claim (runs server-side post-response); this
// endpoint is a manual/backup trigger the claim page can call (e.g. for wallets
// that claimed before the faucet existed, or if the post-claim drip didn't land).
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { dripGas } from "@/lib/gas-drip";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // the on-chain transfer + receipt can take a few seconds

export async function POST() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const result = await dripGas(s.address.toLowerCase());
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
