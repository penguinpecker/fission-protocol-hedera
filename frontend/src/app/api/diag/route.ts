// POST /api/diag — debug log forwarder.
//
// Client components POST a small JSON envelope describing render state
// (wallet status, route, error) so we can read it via `vercel logs`
// without needing the user to copy-paste the browser console.
//
// No auth — anyone can POST garbage. We bound payload size (4 KB) and now also
// apply a best-effort per-IP rate limit (WEB2-07). The body is only
// console.log'd; never persisted, never surfaced to anyone else.

import { NextResponse, type NextRequest } from "next/server";
import { rateLimit, clientIp } from "@/lib/rate-limit";

const MAX_BYTES = 4096;

export async function POST(req: NextRequest) {
  // WEB2-07: best-effort per-IP cap so this unauth log sink can't be spammed
  // into flooding the log stream from a single hot instance. 60/min is generous
  // for legitimate client render-state pings. See lib/rate-limit.ts.
  const rl = rateLimit(`diag:${clientIp(req)}`, 60, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  // Tag with a stable prefix for easy grep in `vercel logs`.
  console.log(`[fission-diag]`, JSON.stringify(body));
  return NextResponse.json({ ok: true });
}
