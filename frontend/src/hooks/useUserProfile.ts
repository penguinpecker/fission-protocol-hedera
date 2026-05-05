// Read + update the signed-in user's profile row. RLS scopes everything to
// the JWT's `sub` (their EVM address) so the same hook is safe regardless of
// what address the caller claims.

"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

export interface UserProfile {
  address: string;
  display_name: string | null;
  avatar_url: string | null;
  twitter_handle: string | null;
  created_at: string;
  updated_at: string;
}

export function useUserProfile(address: string | undefined) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    const supa = createClient();
    const { data, error } = await supa
      .from("users")
      .select("*")
      .eq("address", address.toLowerCase())
      .maybeSingle();
    if (error) setError(error.message);
    else setProfile((data as UserProfile) ?? null);
    setLoading(false);
  }, [address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateProfile = useCallback(
    async (patch: Partial<Pick<UserProfile, "display_name" | "avatar_url" | "twitter_handle">>) => {
      if (!address) throw new Error("not_connected");
      const supa = createClient();
      const { data, error } = await supa
        .from("users")
        .upsert(
          { address: address.toLowerCase(), ...patch },
          { onConflict: "address" }
        )
        .select()
        .single();
      if (error) throw error;
      setProfile(data as UserProfile);
      return data as UserProfile;
    },
    [address]
  );

  return { profile, loading, error, refresh, updateProfile };
}
