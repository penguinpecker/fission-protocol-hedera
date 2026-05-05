// Read + update the signed-in user's profile via the /api/profile API
// route. The route validates the session cookie and uses service-role
// against Supabase, so the frontend never holds DB credentials.

"use client";

import { useCallback, useEffect, useState } from "react";

export interface UserProfile {
  address: string;
  display_name: string | null;
  avatar_url: string | null;
  twitter_handle: string | null;
  created_at: string;
  updated_at: string;
}

export type ProfilePatch = Partial<
  Pick<UserProfile, "display_name" | "avatar_url" | "twitter_handle">
>;

export function useUserProfile() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/profile", { credentials: "include" });
      if (r.status === 401) {
        setProfile(null);
        return;
      }
      if (!r.ok) throw new Error(`profile_fetch_${r.status}`);
      const j = (await r.json()) as { profile: UserProfile | null };
      setProfile(j.profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateProfile = useCallback(
    async (patch: ProfilePatch): Promise<UserProfile> => {
      const r = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `update_${r.status}`);
      }
      const j = (await r.json()) as { profile: UserProfile };
      setProfile(j.profile);
      return j.profile;
    },
    []
  );

  return { profile, loading, error, refresh, updateProfile };
}
