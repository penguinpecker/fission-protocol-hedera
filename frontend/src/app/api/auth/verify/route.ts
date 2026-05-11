// POST /api/auth/verify
//
// Body: { message: string, signature: string }
// Returns: { ok: true, address: string } and sets the session cookie.
//
// Validates the SIWE message + signature, marks the nonce consumed, upserts
// the user row, and sets an httpOnly session cookie signed with our own
// SESSION_SECRET. Subsequent requests carry the cookie automatically.

import { NextResponse, type NextRequest } from "next/server";
import { SiweMessage } from "siwe";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { signSession, attachSessionCookie } from "@/lib/auth/session";

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

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    return NextResponse.json({ error: "siwe_parse" }, { status: 400 });
  }

  // Domain pinning: the SIWE message must claim our origin. We derive the
  // expected host from the actual request, then in production additionally
  // require it to be in a hardcoded allowlist — this protects against a
  // misconfigured Origin header on a third-party deploy that happens to share
  // our supabase project (defense in depth; the SIWE signature itself already
  // proves the user signed for that domain).
  const originHost = (() => {
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        return new URL(origin).host;
      } catch {
        /* fall through */
      }
    }
    return req.headers.get("host") ?? "localhost";
  })();

  if (process.env.NODE_ENV === "production") {
    const PROD_HOSTS = new Set(["fissionp.com", "www.fissionp.com"]);
    const isPreview =
      originHost.endsWith(".vercel.app") &&
      originHost.startsWith("frontend-");
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost);
    if (!PROD_HOSTS.has(originHost) && !isPreview && !isLocal) {
      console.error("verify: untrusted origin", { originHost });
      return NextResponse.json(
        { error: "untrusted_origin", host: originHost },
        { status: 401 },
      );
    }
  }

  let verified;
  try {
    verified = await siwe.verify({
      signature,
      domain: originHost,
      nonce: siwe.nonce,
    });
  } catch (e) {
    console.error("siwe verify threw", { originHost, msgDomain: siwe.domain, err: String(e) });
    return NextResponse.json(
      { error: "siwe_verify_threw", expected: originHost, gotInMessage: siwe.domain, detail: String(e) },
      { status: 401 },
    );
  }
  if (!verified.success) {
    console.error("siwe verify failed", { originHost, msgDomain: siwe.domain });
    return NextResponse.json(
      { error: "siwe_verify_failed", expected: originHost, gotInMessage: siwe.domain },
      { status: 401 },
    );
  }
  if (siwe.chainId !== EXPECTED_CHAIN_ID) {
    return NextResponse.json({ error: "wrong_chain" }, { status: 400 });
  }

  const lower = siwe.address.toLowerCase();
  const supa = createServiceRoleClient();

  // Atomic nonce flip — only the request that wins the race gets a row.
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

  // Upsert the user. Service-role bypasses RLS.
  await supa.from("users").upsert(
    { address: lower },
    { onConflict: "address", ignoreDuplicates: true }
  );

  const token = await signSession(lower);
  const res = NextResponse.json({ ok: true, address: lower });
  attachSessionCookie(res, token);
  return res;
}
