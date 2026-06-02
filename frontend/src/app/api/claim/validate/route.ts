// POST /api/claim/validate — public pre-check for the /claim Step 1.
//
// Confirms a code exists AND is still unclaimed, BEFORE the user connects a
// wallet. Returns only { valid, reason } — no owner/account data leaks. This is
// a UX pre-check; the authoritative, race-safe redemption still happens in
// POST /api/claim (conditional update under the session). Enumeration isn't a
// real threat: the 6-char unambiguous space is ~887M for 1,000 live codes, so
// a random guess hits ~1 in 887,000.
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const CODE_RE = /^[A-Z0-9]{6}$/;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false, reason: "invalid" }, { status: 200 });
  }
  const raw = (body as { code?: unknown })?.code;
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!CODE_RE.test(code)) {
    return NextResponse.json({ valid: false, reason: "invalid" }, { headers: { "cache-control": "no-store" } });
  }

  const supa = createServiceRoleClient();
  const { data } = await supa.from("claim_codes").select("claimed").eq("code", code).maybeSingle();

  if (!data) {
    return NextResponse.json({ valid: false, reason: "invalid" }, { headers: { "cache-control": "no-store" } });
  }
  if (data.claimed) {
    return NextResponse.json({ valid: false, reason: "used" }, { headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json({ valid: true }, { headers: { "cache-control": "no-store" } });
}
