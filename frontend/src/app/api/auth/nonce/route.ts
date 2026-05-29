// POST /api/auth/nonce
//
// Body: { address: string }
// Returns: { nonce: string, issuedAt: number, expiresAt: number }
//
// Generates a single-use SIWE nonce for the given address, stores it in
// `auth_nonces` (service-role only), and returns the nonce. Client embeds
// the nonce in the SIWE message before asking the wallet to sign.
//
// Hardening:
//   - 32 bytes of CSPRNG, hex-encoded → 64-char nonce. SIWE spec requires ≥8.
//   - 5-minute TTL. Past that, /api/auth/verify will reject.
//   - Address normalized (lowercased + EVM-format checked) before insert.
//   - At most 5 unconsumed nonces per address — old ones are pruned to bound
//     storage growth from probing.

import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit, clientIp } from "@/lib/rate-limit";

const NONCE_TTL_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  // Parse + validate the address FIRST so the rate-limit bucket can be keyed
  // per (IP, address) rather than per-IP alone. Keying on IP-only locked out
  // co-located users behind shared NAT/CGNAT/corporate/conference egress: a
  // single bucket on the first x-forwarded-for hop is shared by everyone on
  // that network, so a cohort signing in together exhausted it and the rest
  // got an opaque sign-in failure. (RATELIMIT-SHARED-IP-NAT)
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const address = (body as { address?: unknown })?.address;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  const lower = address.toLowerCase();

  // WEB2-07: best-effort cap (no new infra), now keyed per (IP, address) and
  // raised to 100 mints/min. This still bounds the DB write-amplification the
  // original finding was about — a single signer can mint at most 100
  // nonces/min — while letting distinct wallets behind ONE egress IP each get
  // their own bucket, so they no longer collide. See lib/rate-limit.ts.
  const rl = rateLimit(`nonce:${clientIp(req)}:${lower}`, 100, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: "rate_limited",
        // Actionable, human-readable so the client can show it verbatim
        // instead of the opaque "nonce_failed".
        message: `Too many sign-in attempts. Please wait ~${rl.retryAfter}s and try again.`,
        retryAfter: rl.retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const nonce = randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = new Date(now + NONCE_TTL_MS).toISOString();
  const issuedAtIso = new Date(now).toISOString();

  const supa = createServiceRoleClient();

  // Bound storage: keep the 5 most recent unconsumed nonces per address;
  // delete older ones. (At-most-5 unconsumed; ignore consumed history.)
  // Done in two queries for clarity; an RPC would be marginally faster.
  const { data: existing } = await supa
    .from("auth_nonces")
    .select("nonce")
    .eq("address", lower)
    .is("consumed_at", null)
    .order("issued_at", { ascending: false })
    .limit(50);

  if (existing && existing.length >= 5) {
    const stale = existing.slice(4).map(r => r.nonce);
    await supa.from("auth_nonces").delete().in("nonce", stale);
  }

  const { error } = await supa.from("auth_nonces").insert({
    nonce,
    address: lower,
    issued_at: issuedAtIso,
    expires_at: expiresAt,
  });
  if (error) {
    console.error("nonce insert", error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  return NextResponse.json({
    nonce,
    issuedAt: now,
    expiresAt: now + NONCE_TTL_MS,
  });
}
