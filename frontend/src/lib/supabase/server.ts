// Server-side Supabase clients. Two flavors:
//   • createServerClient — anon key + cookies, so RLS sees the user's JWT
//     (this is what page-server-components/route handlers should use for
//     reads/writes on behalf of the signed-in user).
//   • createServiceRoleClient — service-role key, bypasses RLS. Use ONLY for
//     auth_nonces (server-only table) and indexer writes. Never expose this
//     client over the network or import it into a "use client" file.

import { createServerClient as createSupaServerClient } from "@supabase/ssr";
import { createClient as createSupaClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function createServerClient() {
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY must be set");
  }
  const cookieStore = await cookies();
  return createSupaServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(items) {
        for (const { name, value, options } of items) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}

/**
 * Service-role client. **Server-only**. Bypasses RLS — used for the
 * auth_nonces table and indexer writes only. Throws if a service-role key
 * isn't configured (refuse to silently fall back to anon for a service-only
 * code path).
 */
export function createServiceRoleClient() {
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svcKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createSupaClient(url, svcKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
