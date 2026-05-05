// JWT issuance for the SIWE → Supabase Auth bridge.
//
// After /api/auth/verify validates the SIWE message, it signs a Supabase-shaped
// JWT (HS256, signed with the project's JWT secret) and hands it to the client,
// which calls supabase.auth.setSession with it. From then on, supabase-js sends
// the JWT on every request and Postgres RLS sees the user's wallet address as
// auth.jwt() ->> 'sub'.
//
// Top-tier hardening here:
//   - HS256 with the project JWT secret. Only the server knows the secret.
//   - 1-hour access tokens, 30-day refresh tokens.
//   - `aud` MUST equal "authenticated" so Supabase's GoTrue accepts it.
//   - `sub` is the lowercased EVM address — RLS filters by `lower(addr) = jwt_address()`.
//   - `role` claim is "authenticated" so PostgREST routes through RLS, not bypass.

import { SignJWT } from "jose";
import { randomBytes } from "node:crypto";

const ONE_HOUR = 60 * 60;
const THIRTY_DAYS = 30 * 24 * 60 * 60;

function getSecret(): Uint8Array {
  const s = process.env.SUPABASE_JWT_SECRET;
  if (!s) throw new Error("SUPABASE_JWT_SECRET is required to sign auth tokens");
  return new TextEncoder().encode(s);
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: "bearer";
  user: {
    id: string;
    address: string;
    role: "authenticated";
  };
}

/**
 * Issue Supabase-compatible access + refresh tokens for a verified wallet.
 * `address` MUST already be lowercased.
 */
export async function issueTokensForAddress(address: string): Promise<IssuedTokens> {
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error("issueTokensForAddress: address must be lowercased EVM hex");
  }

  const secret = getSecret();
  const issuedAt = Math.floor(Date.now() / 1000);
  const accessExpiry = issuedAt + ONE_HOUR;
  const refreshExpiry = issuedAt + THIRTY_DAYS;

  // The Supabase Auth JWT shape that GoTrue + PostgREST expect.
  const accessToken = await new SignJWT({
    role: "authenticated",
    aal: "aal1",
    amr: [{ method: "siwe", timestamp: issuedAt }],
    session_id: randomBytes(16).toString("hex"),
    is_anonymous: false,
    user_metadata: { address },
    app_metadata: { provider: "siwe", providers: ["siwe"] },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(address)
    .setAudience("authenticated")
    .setIssuer(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`)
    .setIssuedAt(issuedAt)
    .setExpirationTime(accessExpiry)
    .sign(secret);

  // Refresh tokens for our SIWE flow are opaque random values stored in a
  // signed JWT envelope. The /api/auth/refresh endpoint validates the
  // envelope and re-issues a fresh access_token. We do NOT track these in
  // the DB in v1 — replay protection comes from the short access-token TTL.
  // (For revocation we'd add a refresh_tokens table; left as v2.)
  const refreshToken = await new SignJWT({
    typ: "refresh",
    address,
    jti: randomBytes(16).toString("hex"),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(address)
    .setIssuedAt(issuedAt)
    .setExpirationTime(refreshExpiry)
    .sign(secret);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ONE_HOUR,
    expires_at: accessExpiry,
    token_type: "bearer",
    user: { id: address, address, role: "authenticated" },
  };
}
