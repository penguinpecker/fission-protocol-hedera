// /ref?r=<code> — referral landing. Stores the code in an httpOnly cookie
// (read server-side by the SIWE verify route at sign-in) then redirects home.
// httpOnly so client JS can't read/forge it; the only consumer is the auth hook.
import { NextResponse, type NextRequest } from "next/server";
import { REF_COOKIE, REF_CODE_RE } from "@/lib/referrals";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const code = (new URL(req.url).searchParams.get("r") ?? "").toLowerCase();
  const res = NextResponse.redirect(new URL("/", req.url));
  if (REF_CODE_RE.test(code)) {
    res.cookies.set(REF_COOKIE, code, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
  }
  return res;
}
