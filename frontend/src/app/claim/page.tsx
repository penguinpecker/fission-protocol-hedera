"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useSwitchChain } from "wagmi";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { WalletPicker } from "@/components/WalletPicker";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { HEDERA_MAINNET_CHAIN_ID, HEDERA_ADD_PARAMS } from "@/lib/wagmi";

/**
 * /claim — marketing access-code landing page.
 *
 * Flow (code-first, two real steps):
 *   Step 1 — enter the 6-char code; it's validated against the DB (exists +
 *            unclaimed) BEFORE moving on.
 *   Step 2 — connect wallet (connect + SIWE sign-in, two prompts); the validated
 *            code auto-redeems against the signed-in wallet → sent to /markets.
 *
 * The page drives its OWN connect→sign flow (its own useSiweAuth instance) and
 * dispatches `fp:auth-changed` so the Nav's instance stays in sync. Eligibility
 * for the free mint = claimed AND >=1 on-chain tx; rarity then scales with dApp
 * usage (leaderboard rank at season end). Both wallet types track via
 * users.account_id resolution server-side.
 */
export default function ClaimPage() {
  return (
    <main className="min-h-screen text-text">
      <Nav />
      <ClaimBody />
      <Footer />
    </main>
  );
}

type ClaimMe = { loaded: boolean; claimed: boolean; code: string | null; eligible: boolean };

const CLAIM_ERROR_COPY: Record<string, string> = {
  invalid_code: "That code isn't valid. Double-check it and try again.",
  code_used: "That code has already been claimed.",
  unauthenticated: "Please connect your wallet to claim.",
  claim_failed: "Something went wrong claiming that code. Try again.",
};

function ClaimBody() {
  const router = useRouter();
  const adapter = useWalletAdapter();
  const wagmiAcct = useAccount();
  const { switchChain } = useSwitchChain();
  const { state: auth, signIn } = useSiweAuth();

  // MetaMask on the wrong network can't sign for Hedera; mirror the Nav's gate
  // using the wallet's REAL chain (useAccount().chainId, not useChainId()).
  const onWrongChain =
    adapter.mode === "evm" &&
    wagmiAcct.isConnected &&
    wagmiAcct.chainId !== HEDERA_MAINNET_CHAIN_ID;

  const [pickerOpen, setPickerOpen] = useState(false);
  const autoSignRef = useRef(false);
  // One-shot: set when the user reaches Step 2 and connects, so the validated
  // code auto-redeems the moment sign-in lands.
  const claimAfterAuthRef = useRef(false);

  const [step, setStep] = useState<1 | 2>(1);
  const [code, setCode] = useState("");
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justClaimed, setJustClaimed] = useState(false);
  const [claim, setClaim] = useState<ClaimMe>({ loaded: false, claimed: false, code: null, eligible: false });

  const authed = auth.status === "authenticated";

  // Auto add+switch to Hedera for MetaMask (Nav does this globally too; harmless
  // to repeat, keeps the page self-sufficient if the Nav were ever absent).
  useEffect(() => {
    if (onWrongChain) {
      switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID, addEthereumChainParameter: HEDERA_ADD_PARAMS });
    }
  }, [onWrongChain, switchChain]);

  // Fire SIWE right after a click-initiated connect — but only once the chain is
  // correct, so MetaMask sees add → switch → sign in a clean sequence.
  useEffect(() => {
    if (
      autoSignRef.current &&
      adapter.isConnected &&
      adapter.address &&
      auth.status === "idle" &&
      !onWrongChain
    ) {
      autoSignRef.current = false;
      void signIn();
    }
  }, [adapter.isConnected, adapter.address, auth.status, signIn, onWrongChain]);

  // Let the Nav's separate useSiweAuth instance re-sync once we're signed in.
  useEffect(() => {
    if (authed) window.dispatchEvent(new Event("fp:auth-changed"));
  }, [authed]);

  // Pull this wallet's existing claim status once signed in.
  useEffect(() => {
    if (!authed) {
      setClaim({ loaded: false, claimed: false, code: null, eligible: false });
      return;
    }
    let cancelled = false;
    fetch("/api/claim/me", { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d) setClaim({ loaded: true, claimed: Boolean(d.claimed), code: d.code ?? null, eligible: Boolean(d.eligible) });
        else setClaim((s) => ({ ...s, loaded: true }));
      })
      .catch(() => {
        if (!cancelled) setClaim((s) => ({ ...s, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  const submit = useCallback(async () => {
    setError(null);
    const c = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) {
      setError("Enter your 6-character code.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: c }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; code?: string; error?: string };
      if (!r.ok || !j.ok) {
        setError(CLAIM_ERROR_COPY[j.error ?? ""] ?? "Couldn't claim that code. Try again.");
        setSubmitting(false);
        return;
      }
      setJustClaimed(true);
      setClaim({ loaded: true, claimed: true, code: j.code ?? c, eligible: false });
      // Land them on Markets (already signed in) after a beat of confirmation.
      setTimeout(() => router.push("/markets"), 1400);
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }, [code, router]);

  // Once signed in with a pending claim (and no existing claim), redeem the
  // validated code automatically — this is what "Step 2 → markets" hinges on.
  useEffect(() => {
    if (
      claimAfterAuthRef.current &&
      authed &&
      claim.loaded &&
      !claim.claimed &&
      !submitting &&
      !justClaimed
    ) {
      claimAfterAuthRef.current = false;
      void submit();
    }
  }, [authed, claim.loaded, claim.claimed, submitting, justClaimed, submit]);

  const handleConnectStarted = () => {
    autoSignRef.current = true;
  };

  // ── Step 1: validate the code against the DB (exists + unclaimed). Only on
  // success do we advance to Step 2. No wallet involved yet.
  const validateCode = useCallback(async () => {
    setError(null);
    const c = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) {
      setError("Enter your 6-character code.");
      return;
    }
    setValidating(true);
    try {
      const r = await fetch("/api/claim/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: c }),
      });
      const j = (await r.json().catch(() => ({}))) as { valid?: boolean; reason?: string };
      if (j.valid) {
        setStep(2);
      } else {
        setError(
          j.reason === "used"
            ? "That code has already been claimed."
            : "That code isn't valid. Double-check it and try again.",
        );
      }
    } catch {
      setError("Couldn't check that code. Try again.");
    } finally {
      setValidating(false);
    }
  }, [code]);

  // ── Step 2: connect + sign (or claim directly if already signed in). The
  // auto-claim effect finishes the redemption once authenticated.
  const connectAndClaim = useCallback(() => {
    setError(null);
    if (authed) {
      void submit();
      return;
    }
    claimAfterAuthRef.current = true;
    if (adapter.isConnected && adapter.address) {
      void signIn(); // wallet connected, just needs the signature
    } else {
      autoSignRef.current = true;
      setPickerOpen(true); // connect → auto-sign → auto-claim
    }
  }, [authed, adapter.isConnected, adapter.address, signIn, submit]);

  const backToStep1 = () => {
    claimAfterAuthRef.current = false;
    setError(null);
    setStep(1);
  };

  const signingIn = auth.status === "loading";

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        {/* faint grid backdrop */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />
        <div className="relative mx-auto max-w-[1180px] px-4 py-12 sm:px-6 lg:py-16">
          {/* ── Heading ─────────────────────────────────────────────── */}
          <div className="text-center">
            <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-textDim">
              protocol / claim
            </div>
            <h1 className="text-[30px] font-semibold leading-tight text-text sm:text-[40px]">
              Claim your access code
            </h1>
            <p className="mx-auto mt-3 max-w-2xl text-[14px] leading-relaxed text-textSec">
              Got a code from us? Enter it below, connect your wallet, and you&apos;re in — straight to the
              markets. Fission tokenizes yield on Hedera: split a yield-bearing position into a fixed-rate
              principal token and a separate yield token, then trade either one.
            </p>
          </div>

          {/* ── Hero media: full portrait video + free-mint details ───── */}
          <div className="mt-9 flex flex-col items-center justify-center gap-7 sm:mt-11 sm:flex-row sm:items-center sm:gap-8">
            <video
              src="/claim-intro.mp4"
              autoPlay
              loop
              muted
              playsInline
              aria-label="Fission Protocol Genesis Pass"
              className="block h-[360px] w-auto rounded-[12px] border border-border bg-black sm:h-[460px]"
            />

            <div className="w-full max-w-[400px] rounded-[12px] border border-border bg-bgCard p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-textDim">
                  Free access NFT
                </div>
                <span className="rounded-[2px] border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-textSec">
                  Limited
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <MintStat label="Mint price" value="Free" />
                <MintStat label="Supply" value="1,000" />
                <MintStat label="To qualify" value="1 trade" />
              </div>
              <p className="mt-4 text-[13px] leading-relaxed text-textSec">
                A limited run of 1,000 — free to mint.
              </p>
              {/* Highlighted eligibility requirement. */}
              <div className="mt-3 flex items-start gap-2 rounded-[6px] border-l-2 border-warning bg-warning/[0.10] px-3 py-2.5">
                <svg viewBox="0 0 24 24" className="mt-px size-3.5 flex-shrink-0 text-warning" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2 4.5 13H11l-1 9 8.5-11H12z" />
                </svg>
                <span className="text-[12.5px] font-semibold leading-snug text-text">
                  You must complete at least one transaction on Fission to be eligible.
                </span>
              </div>

              {/* Rarity is earned ── tied to dApp usage / leaderboard rank. */}
              <div className="mt-4 rounded-[8px] border border-border bg-black/20 p-3.5">
                <div className="flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="size-4 text-text" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2 15 9l7 .5-5.5 4.5L18 21l-6-3.8L6 21l1.5-7L2 9.5 9 9z" />
                  </svg>
                  <span className="text-[12px] font-semibold text-text">Rarity is earned</span>
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-textSec">
                  The more you use Fission, the rarer your NFT. Your place on the leaderboard at the end of
                  the season sets your mint&apos;s rarity tier — the higher you rank, the rarer it gets.
                </p>
              </div>
            </div>
          </div>

          {/* ── Claim widget — centered, below the hero media ─────────── */}
          <div className="mx-auto mt-11 max-w-[520px] sm:mt-14">
            <div className="rounded-[10px] border border-border bg-bgCard p-5 sm:p-6">
              {justClaimed ? (
                <ClaimedSuccess />
              ) : authed && claim.loaded && claim.claimed ? (
                <AlreadyClaimed code={claim.code} eligible={claim.eligible} onGo={() => router.push("/markets")} />
              ) : step === 1 ? (
                <StepEnterCode
                  code={code}
                  setCode={setCode}
                  validating={validating}
                  error={error}
                  onContinue={validateCode}
                />
              ) : (
                <StepConnect
                  code={code}
                  authed={authed}
                  submitting={submitting}
                  signingIn={signingIn}
                  onWrongChain={onWrongChain}
                  error={error}
                  onConnect={connectAndClaim}
                  onBack={backToStep1}
                />
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1180px] px-4 py-10 sm:px-6 sm:py-12">
        <div className="mb-5 font-mono text-[11px] uppercase tracking-[0.18em] text-textDim">
          how it works
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <HowCard
            tag="PT"
            title="Principal Token"
            body="Lock in a fixed yield. PT trades at a discount and is redeemable 1:1 for the underlying at maturity."
          />
          <HowCard
            tag="YT"
            title="Yield Token"
            body="Hold the yield stream. YT pays out the variable yield of the underlying for as long as you hold it."
          />
          <HowCard
            tag="LP"
            title="Liquidity"
            body="Provide PT/SY liquidity into the market and earn a share of every trade's fees."
          />
        </div>
      </section>

      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onConnectStarted={handleConnectStarted} />
    </>
  );
}

/* ───────────────────────── shared: the eligibility callout ───────────────── */

function EligibilityCallout() {
  return (
    <div className="mt-4 flex items-start gap-2.5 rounded-[8px] border border-warning/30 bg-warning/[0.07] px-3.5 py-3">
      <svg viewBox="0 0 24 24" className="mt-px size-4 flex-shrink-0 text-warning" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2 4.5 13H11l-1 9 8.5-11H12z" />
      </svg>
      <div>
        <div className="text-[12.5px] font-semibold text-text">One transaction unlocks your mint</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-textSec">
          Claiming a code grants access. To become eligible for the free NFT you must complete at least one
          transaction on Fission afterward.
        </p>
      </div>
    </div>
  );
}

/* ───────────────────────────── Step 1: enter + validate code ─────────────── */

function StepEnterCode({
  code,
  setCode,
  validating,
  error,
  onContinue,
}: {
  code: string;
  setCode: (v: string) => void;
  validating: boolean;
  error: string | null;
  onContinue: () => void;
}) {
  return (
    <div>
      <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-textDim">Step 1 of 2 — your code</div>
      <h2 className="mt-1 text-[16px] font-semibold text-text">Enter your access code</h2>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !validating) onContinue();
        }}
        placeholder="ABC123"
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={6}
        className="mt-3 w-full rounded-[2px] border border-border bg-black/30 px-4 py-3 text-center font-mono text-[22px] uppercase tracking-[0.5em] text-text outline-none transition placeholder:text-textDim/50 focus:border-borderHover"
      />
      {error && <div className="mt-3 font-mono text-[12px] leading-relaxed text-error">{error}</div>}

      <EligibilityCallout />

      <button
        type="button"
        onClick={onContinue}
        disabled={validating || code.length !== 6}
        className="mt-4 w-full rounded-[2px] border border-white bg-white px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {validating ? "Checking…" : "Continue"}
      </button>
      <p className="mt-2.5 text-center text-[11px] leading-relaxed text-textDim">
        We&apos;ll verify your code, then connect your wallet in the next step.
      </p>
    </div>
  );
}

/* ───────────────────────────── Step 2: connect wallet + claim ────────────── */

function StepConnect({
  code,
  authed,
  submitting,
  signingIn,
  onWrongChain,
  error,
  onConnect,
  onBack,
}: {
  code: string;
  authed: boolean;
  submitting: boolean;
  signingIn: boolean;
  onWrongChain: boolean;
  error: string | null;
  onConnect: () => void;
  onBack: () => void;
}) {
  const busy = submitting || signingIn;
  const label = submitting
    ? "Claiming…"
    : signingIn
      ? "Signing in…"
      : authed
        ? "Claim now"
        : "Connect wallet & claim";
  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-textDim">Step 2 of 2 — connect</div>
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="font-mono text-[11px] text-textDim underline underline-offset-2 transition hover:text-textSec disabled:opacity-40"
        >
          change code
        </button>
      </div>

      {/* Validated code chip */}
      <div className="mt-3 flex items-center justify-between rounded-[2px] border border-success/40 bg-success/[0.06] px-3.5 py-2.5">
        <span className="font-mono text-[18px] tracking-[0.32em] text-text">{code}</span>
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-success">
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          valid
        </span>
      </div>

      <h2 className="mt-4 text-[16px] font-semibold text-text">Connect your wallet</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-textSec">
        Connect HashPack or MetaMask and sign in — two quick prompts, no gas. Your code redeems
        automatically and we&apos;ll take you to the markets.
      </p>

      <EligibilityCallout />

      {error && <div className="mt-3 font-mono text-[12px] leading-relaxed text-error">{error}</div>}

      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="mt-4 w-full rounded-[2px] border border-white bg-white px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
      {onWrongChain && (
        <p className="mt-2.5 text-center text-[11px] leading-relaxed text-warning">
          Switch your wallet to Hedera Mainnet — we&apos;ll prompt you automatically.
        </p>
      )}
    </div>
  );
}

/* ───────────────────────────── post-claim states ─────────────────────────── */

function ClaimedSuccess() {
  return (
    <div className="text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-success/40 bg-success/10">
        <svg viewBox="0 0 24 24" className="size-6 text-success" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <h2 className="mt-3 text-[16px] font-semibold text-text">Code claimed</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-textSec">
        You&apos;re in. Complete at least one transaction on Fission to qualify for the free mint.
      </p>
      <div className="mt-3 font-mono text-[12px] text-textDim">Taking you to Markets…</div>
    </div>
  );
}

function AlreadyClaimed({ code, eligible, onGo }: { code: string | null; eligible: boolean; onGo: () => void }) {
  return (
    <div>
      <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-textDim">Already claimed</div>
      <h2 className="mt-1 text-[16px] font-semibold text-text">
        You&apos;ve redeemed {code ? <span className="font-mono">{code}</span> : "your code"}
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-textSec">
        {eligible
          ? "You've completed a transaction — you're eligible for the free mint. Keep climbing the leaderboard to raise your rarity tier."
          : "Complete at least one transaction on Fission to qualify for the free mint. The higher you rank, the rarer your NFT."}
      </p>
      <div className="mt-3">
        <span
          className={`inline-flex items-center gap-2 rounded-[2px] border px-2.5 py-1.5 font-mono text-[11px] ${
            eligible ? "border-success/40 text-success" : "border-border text-textSec"
          }`}
        >
          <span className={`size-[6px] rounded-full ${eligible ? "bg-success" : "bg-white/40"}`} />
          {eligible ? "Eligible" : "1 transaction needed"}
        </span>
      </div>
      <button
        type="button"
        onClick={onGo}
        className="mt-4 w-full rounded-[2px] border border-white bg-white px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85"
      >
        Go to Markets
      </button>
    </div>
  );
}

/* ───────────────────────────── small presentational bits ─────────────────── */

function MintStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[6px] border border-border bg-black/20 px-3 py-2.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-textDim">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold text-text">{value}</div>
    </div>
  );
}

function HowCard({ tag, title, body }: { tag: string; title: string; body: string }) {
  return (
    <div className="rounded-[10px] border border-border bg-bgCard p-5">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center justify-center rounded-[2px] border border-borderHover bg-white/[0.04] px-2 py-1 font-mono text-[11px] font-semibold tracking-[0.12em] text-text">
          {tag}
        </span>
        <span className="text-[14px] font-semibold text-text">{title}</span>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-textSec">{body}</p>
    </div>
  );
}
