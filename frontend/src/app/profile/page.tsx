"use client";

import { useState } from "react";
import { Nav } from "@/components/Nav";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { useUserProfile, type ProfilePatch } from "@/hooks/useUserProfile";

export default function ProfilePage() {
  const { state: auth, signIn } = useSiweAuth();
  const { profile, loading, updateProfile } = useUserProfile();

  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [twitterHandle, setTwitterHandle] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (profile && !initialized) {
    setDisplayName(profile.display_name ?? "");
    setAvatarUrl(profile.avatar_url ?? "");
    setTwitterHandle(profile.twitter_handle ?? "");
    setInitialized(true);
  }

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const patch: ProfilePatch = {
        display_name: displayName.trim() || null,
        avatar_url: avatarUrl.trim() || null,
        twitter_handle: twitterHandle.trim() || null,
      };
      await updateProfile(patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "save_failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen">
      <Nav />

      <section className="mx-auto max-w-[600px] px-6 py-10">
        <h1 className="mb-8 text-[28px] font-light tracking-[-0.5px]">
          Your <span className="font-serif italic">profile</span>
        </h1>

        {auth.status !== "authenticated" ? (
          <div className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-border bg-bgCard p-10 text-center">
            <div className="mb-3 text-base font-semibold">Sign in required</div>
            <p className="mb-6 max-w-[400px] text-sm text-textSec">
              Connect your wallet and sign the SIWE message to view your profile.
            </p>
            <button
              type="button"
              onClick={signIn}
              disabled={auth.status === "loading"}
              className="rounded-[10px] bg-white px-6 py-2.5 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
            >
              {auth.status === "loading" ? "Signing…" : "Sign In"}
            </button>
          </div>
        ) : loading ? (
          <div className="h-[400px] animate-pulse rounded-2xl border border-border bg-bgCard" />
        ) : (
          <div className="space-y-6">
            <div className="rounded-2xl border border-border bg-bgCard px-6 py-5">
              <div className="mb-1 text-[10px] uppercase tracking-[1px] text-textDim">
                Wallet address
              </div>
              <div className="font-mono text-sm text-text">
                {profile?.address ?? auth.address}
              </div>
              {profile?.created_at && (
                <div className="mt-3 text-[11px] text-textDim">
                  Member since{" "}
                  {new Date(profile.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-border bg-bgCard px-6 py-5">
              <div className="space-y-5">
                <Field
                  label="Display name"
                  value={displayName}
                  onChange={setDisplayName}
                  placeholder="anon"
                />
                <Field
                  label="Avatar URL"
                  value={avatarUrl}
                  onChange={setAvatarUrl}
                  placeholder="https://..."
                />
                <Field
                  label="Twitter / X"
                  value={twitterHandle}
                  onChange={setTwitterHandle}
                  placeholder="@handle"
                />
              </div>

              <div className="mt-6 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                {saved && (
                  <span className="text-[12px] font-medium text-success">Saved</span>
                )}
                {saveError && (
                  <span className="text-[12px] font-medium text-warning">{saveError}</span>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[10px] uppercase tracking-[1px] text-textDim">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2 text-[13px] text-text placeholder:text-textDim/50 focus:border-borderHover focus:outline-none"
      />
    </div>
  );
}
