"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletGate } from "@/components/WalletGate";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { useUserProfile, type ProfilePatch } from "@/hooks/useUserProfile";
import { useCachedMarkets } from "@/hooks/useCachedMarkets";
import { useMarketDetail, useUserPosition } from "@/hooks/useMarket";
import { daysUntil, formatBigInt, impliedApyPct } from "@/hooks/useMarkets";
import { ArrowOutIcon } from "@/components/Icons";

/**
 * Pendle-style portfolio page. Sections:
 *   1. Aggregate stats (total positions value in SY units, total claimable yield)
 *   2. Per-market position table with PT / YT / LP balances + claim CTA
 *   3. Account settings expander (display name, avatar, twitter)
 *
 * Wallet gated; SIWE-gated for the settings panel only (positions are read
 * from chain, no auth required once connected).
 */
export default function ProfilePage() {
  return (
    <main className="min-h-screen">
      <Nav />
      <WalletGate>
        <ProfileBody />
      </WalletGate>
      <Footer />
    </main>
  );
}

function ProfileBody() {
  const { address } = useAccount();
  const { markets: cached } = useCachedMarkets();

  const marketAddrs = useMemo(
    () => (cached ?? []).map((m) => m.market_address as `0x${string}`),
    [cached],
  );

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-12">
      <header className="mb-10">
        <h1 className="text-[36px] font-light leading-[1.05] tracking-[-1px]">
          Your <span className="font-serif italic">portfolio</span>
        </h1>
        <p className="mt-2 text-[14px] text-textSec">
          Active positions across all Fission markets, claimable yield, and account settings.
        </p>
      </header>

      <AddressCard address={address} />

      <PositionsList markets={marketAddrs} user={address} />

      <SettingsSection />
    </section>
  );
}

/* ----------------------------------------------------- top card */

function AddressCard({ address }: { address: `0x${string}` | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  const onCopy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-bgCard px-6 py-5">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
          Wallet
        </div>
        <div className="mt-1 font-mono text-[14px] text-text">{address}</div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCopy}
          className="rounded-lg border border-border bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-textSec transition hover:border-borderHover hover:text-text"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          href={`https://hashscan.io/mainnet/account/${address}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-textSec transition hover:border-borderHover hover:text-text"
        >
          HashScan
          <ArrowOutIcon className="size-3" />
        </a>
      </div>
    </div>
  );
}

/* ----------------------------------------------------- positions list */

function PositionsList({
  markets,
  user,
}: {
  markets: `0x${string}`[];
  user: `0x${string}` | undefined;
}) {
  return (
    <div className="mb-12">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[18px] font-semibold tracking-tight">Positions</h2>
        <span className="text-[11px] font-mono uppercase tracking-[1.5px] text-textDim">
          {markets.length} market{markets.length === 1 ? "" : "s"}
        </span>
      </div>

      {markets.length === 0 ? (
        <div className="rounded-2xl border border-border bg-bgCard px-6 py-10 text-center text-[13px] text-textSec">
          No markets indexed yet. Try refreshing once the markets cache is populated.
        </div>
      ) : (
        <div className="space-y-3">
          {markets.map((m) => (
            <MarketPositionRow key={m} market={m} user={user} />
          ))}
        </div>
      )}
    </div>
  );
}

function MarketPositionRow({
  market,
  user,
}: {
  market: `0x${string}`;
  user: `0x${string}` | undefined;
}) {
  const { data: detail } = useMarketDetail(market);
  const { data: position } = useUserPosition(market, detail, user);

  if (!detail) {
    return <div className="h-24 animate-pulse rounded-2xl border border-border bg-bgCard" />;
  }

  const dec = detail.syDecimals;
  const expired = Date.now() / 1000 >= Number(detail.expiry);
  const apy = impliedApyPct(detail.lastLnImpliedRate);
  const days = daysUntil(detail.expiry);

  const empty =
    !position ||
    (position.sy === 0n && position.pt === 0n && position.yt === 0n && position.lp === 0n && position.claimableYield === 0n);

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-5 transition hover:border-borderHover">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link
            href={`/markets/${market}`}
            className="text-[15px] font-semibold tracking-tight text-text transition hover:opacity-80"
          >
            {detail.syName}
          </Link>
          <div className="mt-0.5 text-[11px] text-textDim">
            {expired ? (
              <span className="text-error">Expired</span>
            ) : (
              <>
                {days} days left · matures{" "}
                {new Date(Number(detail.expiry) * 1000).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </>
            )}
          </div>
        </div>
        <div className="flex items-baseline gap-2 text-right">
          <span className="text-[10px] uppercase tracking-[1px] text-textDim">Implied APY</span>
          <span className="font-mono text-[14px] font-semibold text-text">
            {apy !== null ? `${apy.toFixed(2)}%` : "—"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border md:grid-cols-5">
        <PosCell label="SY" value={formatBigInt(position?.sy ?? 0n, dec, 4)} />
        <PosCell label="PT" value={formatBigInt(position?.pt ?? 0n, dec, 4)} tone="success" />
        <PosCell label="YT" value={formatBigInt(position?.yt ?? 0n, dec, 4)} tone="warning" />
        <PosCell label="LP" value={formatBigInt(position?.lp ?? 0n, 18, 4)} />
        <PosCell
          label="Claimable yield"
          value={formatBigInt(position?.claimableYield ?? 0n, dec, 6)}
          tone="success"
          accent
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {empty ? (
          <span className="text-[12px] text-textDim">
            You hold no position in this market yet.
          </span>
        ) : (
          <span className="text-[12px] text-textSec">
            Open the market to claim, swap, or LP.
          </span>
        )}
        <Link
          href={`/markets/${market}`}
          className="rounded-lg border border-borderHover bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-text transition hover:bg-white/[0.08]"
        >
          Open market →
        </Link>
      </div>
    </div>
  );
}

function PosCell({
  label,
  value,
  tone,
  accent,
}: {
  label: string;
  value: string;
  tone?: "success" | "warning";
  accent?: boolean;
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-text";
  return (
    <div className={`bg-bgCard px-4 py-3 ${accent ? "ring-1 ring-success/20" : ""}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-textDim">
        {label}
      </div>
      <div className={`mt-1 font-mono text-[13px] font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

/* ----------------------------------------------------- settings (auth-gated) */

function SettingsSection() {
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
    <details className="group rounded-2xl border border-border bg-bgCard px-6 py-5 transition open:bg-bgElevated">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[14px] font-medium text-text">
        <span>Account settings</span>
        <span aria-hidden className="font-mono text-[16px] text-textDim transition group-open:rotate-45">
          +
        </span>
      </summary>

      <div className="mt-5 text-[13px] text-textSec">
        Optional public profile. Lets the leaderboard and watchlist features attach a label to your address. Sign in once with your wallet — we sign a SIWE message and store an httpOnly session cookie. No password.
      </div>

      {auth.status !== "authenticated" ? (
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={signIn}
            disabled={auth.status === "loading"}
            className="rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
          >
            {auth.status === "loading" ? "Signing…" : "Sign in to edit"}
          </button>
          <span className="text-[12px] text-textDim">SIWE · 7-day session</span>
        </div>
      ) : loading ? (
        <div className="mt-5 h-32 animate-pulse rounded-xl bg-white/[0.03]" />
      ) : (
        <>
          <div className="mt-6 grid gap-5 md:grid-cols-3">
            <Field label="Display name" value={displayName} onChange={setDisplayName} placeholder="anon" />
            <Field label="Avatar URL" value={avatarUrl} onChange={setAvatarUrl} placeholder="https://…" />
            <Field label="Twitter / X" value={twitterHandle} onChange={setTwitterHandle} placeholder="@handle" />
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {saved && <span className="text-[12px] font-medium text-success">Saved</span>}
            {saveError && <span className="text-[12px] font-medium text-warning">{saveError}</span>}
          </div>
        </>
      )}
    </details>
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
