// POST /api/auth/verify
//
// Body: { message: string, signature: string }
// Returns: { access_token, refresh_token, expires_in, expires_at, token_type, user }
//
// Validates the SIWE message structure + signature, marks the nonce consumed,
// upserts the user row, and issues a Supabase-shaped JWT pair.
//
// Defense in depth:
//   - SIWE library does signature recovery + structural validation.
//   - We separately enforce: domain matches expected origin, chainId matches
//     our deployment chain, address claimed in message == signer recovered,
//     nonce exists in auth_nonces, not consumed, not expired, address bound
//     to that nonce row.
//   - Nonce flip is atomic: an UPDATE … WHERE consumed_at IS NULL races
//     against a concurrent verify. Postgres returns 0 rows on the loser.
//   - We use the service-role client only for the auth_nonces and user upsert
//     paths. No frontend caller can reach this client.

import { NextResponse, type NextRequest } from "next/server";
import { SiweMessage } from "siwe";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { issueTokensForAddress } from "@/lib/auth/jwt";

const EXPECTED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? "295");

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const message = (body as { message?: unknown })?.message;
  const signature = (body as { signature?: unknown })?.signature;
  if (typeof message !== "string" || typeof signature !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Parse + verify SIWE message structure & signature.
  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    return NextResponse.json({ error: "siwe_parse" }, { status: 400 });
  }

  // Domain pinning: the message must claim the same origin we're serving from.
  // Browsers send the Origin header on cross-origin requests; for same-origin
  // requests, fall back to the Host header. NEXT_PUBLIC_APP_DOMAIN is the
  // canonical override for prod.
  const expectedDomain =
    process.env.NEXT_PUBLIC_APP_DOMAIN ||
    new URL(req.headers.get("origin") || `http://${req.headers.get("host") ?? "localhost"}`).host;

  let verified;
  try {
    verified = await siwe.verify({
      signature,
      domain: expectedDomain,
      // We pull the nonce from the message itself; the lookup below confirms
      // it was issued by us and is still valid.
      nonce: siwe.nonce,
    });
  } catch {
    return NextResponse.json({ error: "siwe_verify" }, { status: 401 });
  }
  if (!verified.success) {
    return NextResponse.json({ error: "siwe_verify" }, { status: 401 });
  }

  if (siwe.chainId !== EXPECTED_CHAIN_ID) {
    return NextResponse.json({ error: "wrong_chain" }, { status: 400 });
  }

  const lower = siwe.address.toLowerCase();
  const supa = createServiceRoleClient();

  // Atomic nonce flip: only the request that wins the race gets a non-empty row.
  const { data: flipped, error: flipErr } = await supa
    .from("auth_nonces")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", siwe.nonce)
    .eq("address", lower)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select()
    .single();

  if (flipErr || !flipped) {
    return NextResponse.json({ error: "invalid_or_expired_nonce" }, { status: 401 });
  }

  // Upsert the user row. RLS allows insert when sub == address; service-role
  // bypasses anyway. We don't overwrite display_name etc. on re-login.
  await supa
    .from("users")
    .upsert(
      { address: lower },
      { onConflict: "address", ignoreDuplicates: true }
    );

  // Issue Supabase-shaped tokens.
  const tokens = await issueTokensForAddress(lower);
  return NextResponse.json(tokens);
}
