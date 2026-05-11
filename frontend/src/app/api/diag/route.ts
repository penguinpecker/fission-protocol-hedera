// POST /api/diag — debug log forwarder.
//
// Client components POST a small JSON envelope describing render state
// (wallet status, route, error) so we can read it via `vercel logs`
// without needing the user to copy-paste the browser console.
//
// No auth — anyone can POST garbage. We bound payload size (4 KB) and
// rate-limit implicitly via Vercel's function timeouts. The body is
// only console.log'd; never persisted, never surfaced to anyone else.

import { NextResponse, type NextRequest } from "next/server";

const MAX_BYTES = 4096;

export async function POST(req: NextRequest) {
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
