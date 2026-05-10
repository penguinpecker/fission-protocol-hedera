// Server-side session: a JWT signed with OUR OWN secret, stored as an
// httpOnly cookie. Independent of Supabase Auth.
//
// Why not Supabase Auth's JWT? Supabase doesn't expose the project's JWT
// secret programmatically (dashboard-only). We sign with our own secret +
// authorize per-route via this helper. RLS on user-scoped tables stays
// configured (defense in depth): API routes use the service-role client
// (which bypasses RLS) and enforce per-user filtering in code.
//
// Top-tier hardening:
//   - HS256 with a 32-byte random secret loaded from SESSION_SECRET env.
//     The .env.local generator picked it via crypto.randomBytes(32).
//   - Cookie flags: HttpOnly, Secure (in prod), SameSite=Lax, Path=/.
//   - 7-day TTL; the cookie expiry matches the JWT exp.
//   - JWT carries `sub = lowercased EVM address` and `siwe_at` (sign-in
//     timestamp) so we can spot suspicious replay activity later.
//   - getSession() returns null on any validation error — never throws to
//     callers, so downstream "if (!session) 401" stays uniform.
//   - Cookies are read directly from the Next.js request context; we never
//     trust an Authorization header for the wallet identity.

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "fission_session";
const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

function getSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET must be set (≥32 chars; generate via crypto.randomBytes(32).toString('hex'))");
  }
  return new TextEncoder().encode(s);
}

// Fail fast at module import: if SESSION_SECRET is missing or too short,
// surface the error on first import rather than letting a silently-
// misconfigured server hand out invalid sessions on the first auth request.
getSecret();

export interface Session {
  address: string; // lowercased EVM hex
  siwe_at: number;
  exp: number;
}

/** Sign a session JWT for `address`. Address must already be lowercased. */
export async function signSession(address: string): Promise<string> {
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error("signSession: address must be lowercased EVM hex");
  }
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ siwe_at: now })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(address)
    .setIssuedAt(now)
    .setExpirationTime(now + SEVEN_DAYS_S)
    .sign(getSecret());
}

/** Verify a session JWT. Returns null on any error. */
export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    const address = payload.sub;
    if (typeof address !== "string" || !/^0x[a-f0-9]{40}$/.test(address)) return null;
    return {
      address,
      siwe_at: typeof payload.siwe_at === "number" ? payload.siwe_at : 0,
      exp: typeof payload.exp === "number" ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}

/** Read + validate the session cookie. For use in route handlers / RSCs. */
export async function getSession(): Promise<Session | null> {
  const c = await cookies();
  const tok = c.get(SESSION_COOKIE)?.value;
  return verifySession(tok);
}

/**
 * Set the session cookie on a NextResponse. Use after SIWE verify.
 * Cookie attributes:
 *   - HttpOnly: not readable from JS (XSS-resistant)
 *   - Secure: in production only (NODE_ENV)
 *   - SameSite=Lax: blocks cross-origin POSTs from third-party sites
 *   - Path=/: available to every route
 */
export function attachSessionCookie(res: NextResponse, token: string) {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SEVEN_DAYS_S,
  });
}

/** Clear the session cookie on a NextResponse. */
export function clearSessionCookie(res: NextResponse) {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** Helper for route handlers that need a session — short-circuit on null. */
export async function requireSession(_req: NextRequest): Promise<Session> {
  const s = await getSession();
  if (!s) throw new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
  return s;
}
