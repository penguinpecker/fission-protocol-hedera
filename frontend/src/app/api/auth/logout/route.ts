// POST /api/auth/logout — revoke the current session server-side and clear
// the browser cookie. Revocation writes revoked_at on the matching
// public.sessions row so a captured cookie can't outlive logout.

import { NextResponse } from "next/server";
import { clearSessionCookie, getSession, revokeSession } from "@/lib/auth/session";

export async function POST() {
  const session = await getSession();
  if (session) {
    await revokeSession(session.jti);
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
