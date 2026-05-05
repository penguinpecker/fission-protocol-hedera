// Browser-side Supabase client. Anon key only; the user's JWT (set via
// supabase.auth.setSession after SIWE) authorizes their RLS-scoped reads
// and writes.

"use client";

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createBrowserClient(url, anonKey);
}
