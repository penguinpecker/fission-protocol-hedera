"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { useSiweAuth } from "@/hooks/useSiweAuth";

type ReferralItem = {
  referee: string;
  code: string;
  signedUpAt: string;
  transacted: boolean;
};

type Resp = {
  code: string | null;
  link: string | null;
  totalSignups: number;
  signupsWithTx: number;
  referralXp: number;
  referrals: ReferralItem[];
};

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

export default function ReferralsPage() {
  return (
    <main className="min-h-screen text-text">
      <Nav />
      <ReferralsBody />
      <Footer />
    </main>
  );
}

function ReferralsBody() {
  const { state: auth, signIn } = useSiweAuth();
  const [data, setData] = useState<Resp | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unauth" | "error">("loading");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const r = await fetch("/api/referrals/me", { cache: "no-store", credentials: "include" });
      if (r.status === 401) {
        setState("unauth");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Resp);
      setState("ok");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-probe whenever the shared auth flips to authenticated — a user who signs
  // in via the Nav while sitting on /referrals should see their link without a
  // manual reload (mode 3 referrals symptom).
  useEffect(() => {
    if (auth.status === "authenticated") void load();
  }, [auth.status, load]);

  const copy = async () => {
    if (!data?.link) return;
    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10 sm:px-6">
      <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-textDim">
        protocol / referrals
      </div>
      <h1 className="text-[26px] font-semibold leading-tight text-text">Referrals</h1>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-textSec">
        Share your link. Earn <span className="text-text">100 XP</span> when someone signs up with
        it, and <span className="text-text">1,000 XP</span> more once they make their first
        transaction. Works for both MetaMask and HashPack sign-ins.
      </p>

      {state === "loading" && (
        <div className="mt-8 font-mono text-[12px] text-textDim">Loading…</div>
      )}

      {state === "unauth" && (
        <div className="mt-8 rounded-[6px] border border-border bg-bgCard px-5 py-8 text-center">
          <p className="font-mono text-[13px] text-textSec">
            Connect your wallet and sign in to get your referral link.
          </p>
          {auth.status !== "authenticated" && (
            <button
              type="button"
              onClick={() => void signIn()}
              className="mt-4 rounded-[4px] border border-white bg-white px-4 py-2 font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-black transition hover:bg-white/85"
            >
              Sign in
            </button>
          )}
        </div>
      )}

      {state === "error" && (
        <div className="mt-8 font-mono text-[12px] text-error">
          Couldn&apos;t load your referral data.{" "}
          <button type="button" onClick={() => void load()} className="underline underline-offset-2">
            Retry
          </button>
        </div>
      )}

      {state === "ok" && data && (
        <>
          {/* link */}
          <div className="mt-6 rounded-[6px] border border-border bg-bgCard p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-textDim">
              Your referral link
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="flex-1 truncate rounded-[4px] border border-border bg-black/40 px-3 py-2 font-mono text-[13px] text-text">
                {data.link ?? "—"}
              </code>
              <button
                type="button"
                onClick={copy}
                disabled={!data.link}
                className="rounded-[4px] border border-white bg-white px-4 py-2 font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-black transition hover:bg-white/85 disabled:opacity-40"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="mt-2 font-mono text-[10px] text-textDim">
              code: <span className="text-textSec">{data.code ?? "—"}</span>
            </div>
          </div>

          {/* stats */}
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="Total signups" value={data.totalSignups} />
            <Stat label="Signups with ≥1 tx" value={data.signupsWithTx} />
            <Stat label="Referral XP earned" value={data.referralXp} />
          </div>

          {/* per-referral list */}
          <div className="mt-6 overflow-hidden rounded-[6px] border border-border bg-bgCard">
            <div className="grid grid-cols-[1fr_150px_90px_110px] gap-2 border-b border-border bg-white/[0.02] px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-textDim">
              <div>Referred wallet</div>
              <div>Signed up</div>
              <div>Code</div>
              <div className="text-right">Status</div>
            </div>
            {data.referrals.length === 0 ? (
              <div className="px-4 py-10 text-center font-mono text-[12px] text-textDim">
                No referrals yet — share your link to get started.
              </div>
            ) : (
              data.referrals.map((r) => (
                <div
                  key={r.referee}
                  className="grid grid-cols-[1fr_150px_90px_110px] items-center gap-2 border-b border-border/60 px-4 py-3 text-[13px] last:border-b-0"
                >
                  <a
                    href={`https://hashscan.io/mainnet/account/${r.referee}`}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono text-text underline-offset-2 hover:underline"
                  >
                    {shortAddr(r.referee)}
                  </a>
                  <div className="font-mono text-[11px] text-textSec">
                    {new Date(r.signedUpAt).toLocaleString()}
                  </div>
                  <div className="font-mono text-[11px] text-textSec">{r.code}</div>
                  <div className="text-right">
                    {r.transacted ? (
                      <span className="inline-block rounded-[2px] border border-success/30 bg-success/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-success">
                        Transacted
                      </span>
                    ) : (
                      <span className="inline-block rounded-[2px] border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-textDim">
                        Signed up
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[6px] border border-border bg-bgCard px-4 py-5">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-textDim">{label}</div>
      <div className="mt-1.5 font-mono text-[26px] font-semibold leading-none text-text">
        {value.toLocaleString()}
      </div>
    </div>
  );
}
