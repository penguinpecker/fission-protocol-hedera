// /api/profile — read or update the current user's profile.
//
// All ops use the service-role Supabase client and enforce per-user filtering
// in code (the address comes from the validated session cookie, not from the
// request body). RLS still exists as defense-in-depth, but we run server-side
// so we control which row gets touched.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/server";

const PatchSchema = z.object({
  display_name: z
    .string()
    .min(1)
    .max(32)
    .nullable()
    .optional(),
  avatar_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional(),
  twitter_handle: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,15}$/)
    .nullable()
    .optional(),
});

export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const supa = createServiceRoleClient();
  const { data, error } = await supa
    .from("users")
    .select("address, display_name, avatar_url, twitter_handle, created_at, updated_at")
    .eq("address", s.address)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profile: data });
}

export async function PATCH(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 400 });
  }

  const supa = createServiceRoleClient();
  const { data, error } = await supa
    .from("users")
    .upsert(
      { address: s.address, ...parsed.data },
      { onConflict: "address" }
    )
    .select("address, display_name, avatar_url, twitter_handle, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profile: data });
}

export async function DELETE() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const supa = createServiceRoleClient();
  const { error } = await supa.from("users").delete().eq("address", s.address);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
