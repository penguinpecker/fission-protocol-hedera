// Server-side session: a JWT signed with OUR OWN secret, stored as an
// httpOnly cookie. Independent of Supabase Auth.
//
// ⚠️ SECURITY BOUNDARY (WEB2-RLS-01): this cookie is a CUSTOM HS256 token, NOT
// a Supabase-Auth JWT. It is never presented to PostgREST, and every route that
// reads/writes user data uses the service-role Supabase client (which bypasses
// RLS). The database RLS policies that key on public.jwt_address() are therefore
// INERT in production — jwt_address() always returns '' because there's no
// Supabase JWT in request.jwt.claims. The REAL per-user boundary is enforced
// HERE + in each route: getSession() validates this cookie, and every per-user
// query filters by `s.address` (.eq('address', s.address)). Audited 2026-05-29:
// /api/profile, /api/watchlists, /api/activity all bind to the session address;
// /api/markets + /api/markets/refresh are public/cron (no per-user rows).
// Do NOT assume RLS is protecting anything on the service-role path.
//
// Hardened design (2026-05-28+):
//   - HS256 with a 32-byte random secret loaded from SESSION_SECRET env.
//   - JWT carries `sub` = lowercased EVM address, `siwe_at` = sign-in ts,
//     and `jti` = UUID identifier indexed in public.sessions.
//   - signSession() inserts a public.sessions row at sign time so revoke
//     paths (logout, admin) can flip revoked_at without rotating the
//     global SESSION_SECRET.
//   - verifySession() does TWO checks: (a) JWT signature + claims valid,
//     (b) the jti exists in public.sessions and revoked_at IS NULL.
//   - Old tokens without a jti claim are rejected (forces re-login once
//     after this migration deploys — only the operator currently has any
//     live session, so impact is one re-login).
//   - Logout / per-session revocation: revokeSession(jti) sets revoked_at.
//   - Cookie flags: HttpOnly, Secure (in prod), SameSite=Lax, Path=/.
//   - 7-day TTL; cookie expiry matches the JWT exp.
//
// One additional Supabase round-trip per authenticated request — cheap
// compared to the gas/RPC fan-out the protocol already does.

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const SESSION_COOKIE = "fission_session";
const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

function getSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET must be set (≥32 chars; generate via crypto.randomBytes(32).toString('hex'))");
  }
  return new TextEncoder().encode(s);
}

// Fail fast on a real server boot: if SESSION_SECRET is missing or too short,
// surface the error on first import rather than letting a silently-
// misconfigured server hand out invalid sessions on the first auth request.
//
// EXCEPTION: skip during `next build` page-data collection
// (NEXT_PHASE === 'phase-production-build'), where Next imports every route
// module WITHOUT runtime secrets present. Without this guard a build in any
// environment that lacks SESSION_SECRET (Vercel Preview, CI) fails to compile.
// getSecret() is still invoked at runtime by signSession()/verifySession(), so a
// genuinely misconfigured *running* server still fails closed on the first auth
// request — only the build-time eager check is relaxed.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  getSecret();
}

export interface Session {
  address: string; // lowercased EVM hex
  siwe_at: number;
  exp: number;
  jti: string;
}

/**
 * Sign a session JWT for `address` and register it in public.sessions so it
 * can be individually revoked later. Address must already be lowercased.
 *
 * Returns the encoded JWT. Caller should set it as a cookie via
 * attachSessionCookie().
 */
export async function signSession(address: string, opts?: { userAgentSummary?: string | null }): Promise<string> {
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error("signSession: address must be lowercased EVM hex");
  }
  const now = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const expSec = now + SEVEN_DAYS_S;

  // Persist BEFORE issuing the cookie so a downstream verify can immediately
  // find the row. On insert failure we throw — better to fail the login than
  // hand out a token that can't be revoked.
  const supa = createServiceRoleClient();
  const { error } = await supa.from("sessions").insert({
    jti,
    address,
    expires_at: new Date(expSec * 1000).toISOString(),
    user_agent_summary: opts?.userAgentSummary ?? null,
  });
  if (error) {
    throw new Error(`signSession: failed to persist session row: ${error.message}`);
  }

  return new SignJWT({ siwe_at: now, jti })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(address)
    .setIssuedAt(now)
    .setExpirationTime(expSec)
    .sign(getSecret());
}

/**
 * Verify a session JWT. Returns null on any validation error or if the
 * matching sessions-table row is missing/revoked.
 */
export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  let address: string;
  let jti: string;
  let siwe_at: number;
  let exp: number;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    const sub = payload.sub;
    const j = payload.jti;
    if (typeof sub !== "string" || !/^0x[a-f0-9]{40}$/.test(sub)) return null;
    if (typeof j !== "string" || j.length === 0) return null; // pre-revocation tokens have no jti
    address = sub;
    jti = j;
    siwe_at = typeof payload.siwe_at === "number" ? payload.siwe_at : 0;
    exp = typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return null;
  }

  // Server-side revocation check.
  const supa = createServiceRoleClient();
  const { data, error } = await supa
    .from("sessions")
    .select("revoked_at, expires_at, address")
    .eq("jti", jti)
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at !== null) return null;
  if (data.address.toLowerCase() !== address) return null; // jti was reissued for someone else? hard reject
  if (new Date(data.expires_at).getTime() < Date.now()) return null;

  return { address, siwe_at, exp, jti };
}

/** Revoke a specific session by jti. Idempotent — already-revoked is OK. */
export async function revokeSession(jti: string): Promise<void> {
  const supa = createServiceRoleClient();
  await supa
    .from("sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("jti", jti)
    .is("revoked_at", null);
}

/** Read + validate the session cookie. For use in route handlers / RSCs. */
export async function getSession(): Promise<Session | null> {
  const c = await cookies();
  const tok = c.get(SESSION_COOKIE)?.value;
  return verifySession(tok);
}

// Cookie attributes.
//   - HttpOnly: not readable from JS (XSS-resistant)
//   - Path=/: available to every route
//   - PRODUCTION: SameSite=None + Secure + Partitioned. REQUIRED because HashPack's
//     mobile dapp-browser loads Fission in a CROSS-ORIGIN IFRAME (provider.tsx
//     isInIframe()). A SameSite=Lax cookie is NEVER sent on requests from a
//     third-party iframe, so the session cookie set at SIWE-verify was silently
//     dropped on every subsequent /api call in-wallet → getSession() null → 401,
//     while the client showed "authenticated" optimistically. SameSite=None makes
//     the cookie ride cross-site; Partitioned (CHIPS) scopes it to the embedding
//     top-level site so it still works as third-party cookies are phased out (and
//     is ignored by browsers that don't support it, degrading to plain None).
//   - DEV: SameSite=Lax + insecure, so it works over http://localhost.
const IS_PROD = process.env.NODE_ENV === "production";
// `partitioned` is a valid Set-Cookie attribute (CHIPS) that Next serializes but
// is absent from some @types builds; build a plain options object and cast at the
// set() call so it always type-checks.
function sessionCookieOpts(value: string, maxAge: number): Record<string, unknown> {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? "none" : "lax",
    partitioned: IS_PROD,
    path: "/",
    maxAge,
  };
}
// The object-form overload param (ResponseCookie), extracted from the union.
type CookieObj = Extract<Parameters<NextResponse["cookies"]["set"]>[0], object>;

/** Set the session cookie on a NextResponse. Use after SIWE verify. */
export function attachSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(sessionCookieOpts(token, SEVEN_DAYS_S) as unknown as CookieObj);
}

/** Clear the session cookie on a NextResponse. Attributes MUST match the set
 *  call (same SameSite/Secure/Partitioned) or the browser won't match+delete it. */
export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(sessionCookieOpts("", 0) as unknown as CookieObj);
}

/** Helper for route handlers that need a session — short-circuit on null. */
export async function requireSession(_req: NextRequest): Promise<Session> {
  const s = await getSession();
  if (!s) throw new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
  return s;
}
