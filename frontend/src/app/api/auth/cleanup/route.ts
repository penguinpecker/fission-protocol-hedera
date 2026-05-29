// /api/auth/cleanup — periodic housekeeping for the auth tables.
//
// WEB2-AUTH-01 + WEB2-07 fix: two migrations
// (20260527230000_lock_users_rls_and_nonces_cleanup.sql,
//  20260528000000_add_sessions_revocation.sql) reference this route as the
// scheduled cleanup path, but it didn't exist (404), so auth_nonces and
// sessions grew unbounded. This route deletes:
//   - consumed nonces older than 1 day,
//   - unconsumed-but-expired nonces older than 1 hour,
//   - expired sessions older than 1 day (covers revoked + lapsed alike).
//
// Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron sets this header).
// Compared in constant time. GET is aliased to POST so the default Vercel Cron
// GET scheduler works.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/auth/timing-safe";

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "cron_secret_unset" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (!timingSafeEqualStr(auth ?? "", `Bearer ${expected}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supa = createServiceRoleClient();
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  let noncesConsumed = 0;
  let noncesExpired = 0;
  let sessionsExpired = 0;

  // 1. Consumed nonces older than a day — they've served their purpose.
  {
    const { error, count } = await supa
      .from("auth_nonces")
      .delete({ count: "exact" })
      .not("consumed_at", "is", null)
      .lt("consumed_at", oneDayAgo);
    if (error) {
      console.error("cleanup nonces(consumed) db_error", error.message);
      return NextResponse.json({ error: "db_error" }, { status: 500 });
    }
    noncesConsumed = count ?? 0;
  }

  // 2. Unconsumed nonces that expired over an hour ago — abandoned challenges.
  {
    const { error, count } = await supa
      .from("auth_nonces")
      .delete({ count: "exact" })
      .is("consumed_at", null)
      .lt("expires_at", oneHourAgo);
    if (error) {
      console.error("cleanup nonces(expired) db_error", error.message);
      return NextResponse.json({ error: "db_error" }, { status: 500 });
    }
    noncesExpired = count ?? 0;
  }

  // 3. Sessions whose JWT has expired (cookie is dead either way). Past-expiry
  //    rows are never consulted by verifySession, so they're safe to prune.
  {
    const { error, count } = await supa
      .from("sessions")
      .delete({ count: "exact" })
      .lt("expires_at", oneDayAgo);
    if (error) {
      console.error("cleanup sessions db_error", error.message);
      return NextResponse.json({ error: "db_error" }, { status: 500 });
    }
    sessionsExpired = count ?? 0;
  }

  return NextResponse.json({
    ok: true,
    deleted: {
      nonces_consumed: noncesConsumed,
      nonces_expired: noncesExpired,
      sessions_expired: sessionsExpired,
    },
  });
}

// Vercel Cron's default scheduler issues GET.
export const GET = POST;
