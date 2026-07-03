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
 *   Step 1 — enter the 6-char code; validated against the DB (exists + unclaimed).
 *   Step 2 — connect wallet (connect + SIWE sign-in); the code auto-redeems.
 * After claiming, a popup shows the wallet's Hedera 0.0.x address (so users can
 * top up from a CEX, which sends to a 0.0.x, not a 0x). The server also drips a
 * little starter HBAR — that transfer auto-creates the Hedera account, which is
 * why the 0.0.x appears a few seconds after claiming.
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

type ClaimMe = {
  loaded: boolean;
  claimed: boolean;
  code: string | null;
  eligible: boolean;
  accountId: string | null; // wallet's Hedera 0.0.x; null until the account exists
};

const EMPTY_CLAIM: ClaimMe = { loaded: false, claimed: false, code: null, eligible: false, accountId: null };

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
  // One-shot: set when the user reaches Step 2, so the validated code redeems the
  // moment sign-in lands (redeem is a server call, not a wallet sign — kept).
  const claimAfterAuthRef = useRef(false);
  const gasFiredRef = useRef(false);

  const [step, setStep] = useState<1 | 2>(1);
  const [code, setCode] = useState("");
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justClaimed, setJustClaimed] = useState(false);
  const [addrModalOpen, setAddrModalOpen] = useState(false);
  const [gasStatus, setGasStatus] = useState<string | null>(null);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [claim, setClaim] = useState<ClaimMe>(EMPTY_CLAIM);

  const authed = auth.status === "authenticated";

  // Auto add+switch to Hedera for MetaMask (Nav does this globally too; harmless
  // to repeat, keeps the page self-sufficient if the Nav were ever absent).
  useEffect(() => {
    if (onWrongChain) {
      switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID, addEthereumChainParameter: HEDERA_ADD_PARAMS });
    }
  }, [onWrongChain, switchChain]);

  // No auto-sign anywhere: signing is user-initiated via StepConnect's button
  // (connectAndClaim → signIn when the wallet is connected). On an in-wallet
  // account switch, useSiweAuth logs the old session out → auth drops to idle;
  // the user taps "Sign in & claim" again for the new account.

  // Let the Nav's separate useSiweAuth instance re-sync once we're signed in.
  useEffect(() => {
    if (authed) window.dispatchEvent(new Event("fp:auth-changed"));
  }, [authed]);

  // Pull this wallet's existing claim status once signed in.
  useEffect(() => {
    if (!authed) {
      setClaim(EMPTY_CLAIM);
      return;
    }
    let cancelled = false;
    fetch("/api/claim/me", { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d)
          setClaim({
            loaded: true,
            claimed: Boolean(d.claimed),
            code: d.code ?? null,
            eligible: Boolean(d.eligible),
            accountId: d.accountId ?? null,
          });
        else setClaim((s) => ({ ...s, loaded: true }));
      })
      .catch(() => {
        if (!cancelled) setClaim((s) => ({ ...s, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  // Once claimed: (1) make sure the starter-HBAR drip ran (after() in /api/claim
  // is the primary trigger; this is a backup that also covers wallets that claimed
  // before the faucet existed — idempotent server-side), and (2) poll for the
  // Hedera 0.0.x to appear, since the drip creates it a few seconds later.
  useEffect(() => {
    if (!authed || !(justClaimed || claim.claimed)) return;
    if (!gasFiredRef.current) {
      gasFiredRef.current = true;
      // Trigger the drip + capture its status so the UI can show an actionable
      // state (e.g. budget exhausted / disabled) instead of an endless spinner.
      void fetch("/api/claim/gas", { method: "POST", credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setGasStatus(d?.status ?? null))
        .catch(() => {});
    }
    if (claim.accountId) return; // already resolved
    let cancelled = false;
    let tries = 0;
    const iv = setInterval(async () => {
      if (cancelled) {
        clearInterval(iv);
        return;
      }
      if (tries++ > 16) {
        clearInterval(iv);
        if (!cancelled) setPollExhausted(true); // ~40s with no account → show self-fund fallback
        return;
      }
      try {
        const r = await fetch("/api/claim/me", { credentials: "include", cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { accountId?: string | null; eligible?: boolean };
        if (d?.accountId) {
          if (!cancelled)
            setClaim((s) => ({ ...s, accountId: d.accountId ?? null, eligible: Boolean(d.eligible) }));
          clearInterval(iv);
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [authed, justClaimed, claim.claimed, claim.accountId, retryNonce]);

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
      setSubmitting(false);
      setJustClaimed(true);
      setClaim({ loaded: true, claimed: true, code: j.code ?? c, eligible: false, accountId: null });
      setAddrModalOpen(true); // show their Hedera address + funding instructions
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }, [code]);

  // Once signed in with a pending claim (and no existing claim), redeem the
  // validated code automatically — this is what "Step 2 → claimed" hinges on.
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

  // ── Step 2: one manual button drives the flow (no auto-sign). Already signed
  // in → redeem. Connected but not signed → sign (the redeem auto-fires once
  // authenticated via claimAfterAuthRef). Not connected → open the picker; after
  // connecting, the user taps the button again to sign.
  const connectAndClaim = useCallback(() => {
    setError(null);
    if (authed) {
      void submit();
      return;
    }
    claimAfterAuthRef.current = true;
    if (adapter.isConnected && adapter.address) {
      void signIn(); // wallet connected → sign now
    } else {
      setPickerOpen(true); // pick a wallet; sign on the next tap
    }
  }, [authed, adapter.isConnected, adapter.address, signIn, submit]);

  const backToStep1 = () => {
    claimAfterAuthRef.current = false;
    setError(null);
    setStep(1);
  };

  const goToMarkets = () => router.push("/markets");
  const retryWallet = () => {
    setPollExhausted(false);
    gasFiredRef.current = false;
    setRetryNonce((n) => n + 1);
  };
  // When the account never appears (slow/failed drip) or the pool is off/empty,
  // fall back to "fund it yourself" guidance instead of an endless spinner.
  const addrFallback = pollExhausted || gasStatus === "disabled" || gasStatus === "budget_exhausted";
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
                <ClaimedSuccess onGo={goToMarkets} onShowAddress={() => setAddrModalOpen(true)} />
              ) : authed && claim.loaded && claim.claimed ? (
                <AlreadyClaimed
                  code={claim.code}
                  eligible={claim.eligible}
                  accountId={claim.accountId}
                  evmAddress={adapter.address ?? null}
                  fallback={addrFallback}
                  onRetry={retryWallet}
                  onGo={goToMarkets}
                />
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
                  walletConnected={adapter.isConnected && !!adapter.address}
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

      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />

      {addrModalOpen && (
        <ClaimAddressModal
          accountId={claim.accountId}
          evmAddress={adapter.address ?? null}
          fallback={addrFallback}
          onRetry={retryWallet}
          onClose={() => setAddrModalOpen(false)}
          onGo={goToMarkets}
        />
      )}
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

/* ───────────── shared: the Hedera-address + funding panel (popup body) ────── */

function HederaAddressPanel({
  accountId,
  evmAddress,
  fallback,
  onRetry,
}: {
  accountId: string | null;
  evmAddress: string | null;
  fallback: boolean;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState("");
  const copy = async (val: string, which: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopied(which);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };

  // Resolved: show the Hedera 0.0.x + exchange funding instructions.
  if (accountId) {
    return (
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-textDim">Your Hedera wallet</div>
        <div className="mt-2 flex items-center justify-between gap-3 rounded-[6px] border border-border bg-black/30 px-3.5 py-3">
          <span className="font-mono text-[18px] text-text">{accountId}</span>
          <button
            type="button"
            onClick={() => copy(accountId, "id")}
            className="flex-shrink-0 rounded-[2px] border border-border px-2.5 py-1.5 font-mono text-[11px] text-textSec transition hover:bg-white/[0.04] hover:text-text"
          >
            {copied === "id" ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <a
          href={`https://hashscan.io/mainnet/account/${accountId}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block font-mono text-[11px] text-textDim underline underline-offset-2 hover:text-textSec"
        >
          View on HashScan ↗
        </a>
        <div className="mt-3 rounded-[6px] border border-border bg-black/20 px-3.5 py-3 text-[12px] leading-relaxed text-textSec">
          <span className="font-semibold text-text">Add funds from an exchange:</span> withdraw{" "}
          <span className="font-semibold text-text">HBAR</span> to this Hedera account ID. Leave the
          memo/note field blank — it&apos;s your personal account. (Exchanges send to a{" "}
          <span className="font-mono">0.0.x</span> ID, not a <span className="font-mono">0x</span>{" "}
          address.)
        </div>
      </div>
    );
  }

  // Fallback: the account didn't get created (slow/failed drip, or the starter pool
  // is off/empty). Let them activate it themselves by sending HBAR to their 0x.
  if (fallback) {
    return (
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-textDim">Activate your wallet</div>
        <p className="mt-2 text-[12px] leading-relaxed text-textSec">
          Your Hedera account isn&apos;t set up yet. Send any amount of{" "}
          <span className="font-semibold text-text">HBAR</span> to your wallet address below (from another
          wallet) to activate it — your Hedera <span className="font-mono">0.0.x</span> ID appears here
          once it lands.
        </p>
        {evmAddress && (
          <div className="mt-2 flex items-center justify-between gap-3 rounded-[6px] border border-border bg-black/30 px-3.5 py-2.5">
            <span className="break-all font-mono text-[12px] text-text">{evmAddress}</span>
            <button
              type="button"
              onClick={() => copy(evmAddress, "evm")}
              className="flex-shrink-0 rounded-[2px] border border-border px-2.5 py-1.5 font-mono text-[11px] text-textSec transition hover:bg-white/[0.04] hover:text-text"
            >
              {copied === "evm" ? "Copied ✓" : "Copy"}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="mt-2.5 rounded-[2px] border border-border px-3 py-2 font-mono text-[11px] text-textSec transition hover:bg-white/[0.04] hover:text-text"
        >
          Check again
        </button>
      </div>
    );
  }

  // Pending: drip in flight, account being created.
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-textDim">Your Hedera wallet</div>
      <div className="mt-2 flex items-center gap-2.5 rounded-[6px] border border-border bg-black/20 px-3.5 py-3">
        <span className="size-3 animate-spin rounded-full border-2 border-textDim border-t-transparent" />
        <span className="text-[12px] leading-relaxed text-textSec">
          Setting up your Hedera wallet — we&apos;re sending a little HBAR to get you started. Your address
          will appear here in a few seconds.
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────── post-claim address popup ──────────────────────── */

function ClaimAddressModal({
  accountId,
  evmAddress,
  fallback,
  onRetry,
  onClose,
  onGo,
}: {
  accountId: string | null;
  evmAddress: string | null;
  fallback: boolean;
  onRetry: () => void;
  onClose: () => void;
  onGo: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[min(460px,94vw)] rounded-[12px] border border-border bg-bgCard p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-addr-title"
      >
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-full border border-success/40 bg-success/10">
            <svg viewBox="0 0 24 24" className="size-5 text-success" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h2 id="claim-addr-title" className="text-[17px] font-semibold text-text">
            You&apos;re in 🎉
          </h2>
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-textSec">
          Your code is redeemed. Here&apos;s your Hedera wallet — save it so you can top it up later.
        </p>

        <div className="mt-4">
          <HederaAddressPanel accountId={accountId} evmAddress={evmAddress} fallback={fallback} onRetry={onRetry} />
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-[8px] border border-warning/30 bg-warning/[0.07] px-3.5 py-3">
          <svg viewBox="0 0 24 24" className="mt-px size-4 flex-shrink-0 text-warning" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2 4.5 13H11l-1 9 8.5-11H12z" />
          </svg>
          <p className="text-[12px] leading-relaxed text-textSec">
            <span className="font-semibold text-text">Last step for the free NFT:</span> make at least one
            transaction on Fission. The higher you climb the leaderboard, the rarer your mint.
          </p>
        </div>

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[2px] border border-border px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-textSec transition hover:bg-white/[0.04] hover:text-text"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onGo}
            className="flex-1 rounded-[2px] border border-white bg-white px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85"
          >
            Go to Markets
          </button>
        </div>
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
  walletConnected,
  submitting,
  signingIn,
  onWrongChain,
  error,
  onConnect,
  onBack,
}: {
  code: string;
  authed: boolean;
  walletConnected: boolean;
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
        : walletConnected
          ? "Sign in & claim"
          : "Connect wallet";
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
        automatically, and we&apos;ll show you your Hedera wallet address next.
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

function ClaimedSuccess({ onGo, onShowAddress }: { onGo: () => void; onShowAddress: () => void }) {
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
      <div className="mt-4 flex flex-col gap-2.5">
        <button
          type="button"
          onClick={onGo}
          className="w-full rounded-[2px] border border-white bg-white px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85"
        >
          Go to Markets
        </button>
        <button
          type="button"
          onClick={onShowAddress}
          className="w-full rounded-[2px] border border-border px-4 py-2.5 text-[12px] text-textSec transition hover:bg-white/[0.04] hover:text-text"
        >
          Show my Hedera address & how to add funds
        </button>
      </div>
    </div>
  );
}

function AlreadyClaimed({
  code,
  eligible,
  accountId,
  evmAddress,
  fallback,
  onRetry,
  onGo,
}: {
  code: string | null;
  eligible: boolean;
  accountId: string | null;
  evmAddress: string | null;
  fallback: boolean;
  onRetry: () => void;
  onGo: () => void;
}) {
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

      {/* Their Hedera address + funding instructions (resolves once the account exists). */}
      <div className="mt-4 rounded-[8px] border border-border bg-black/10 p-3.5">
        <HederaAddressPanel accountId={accountId} evmAddress={evmAddress} fallback={fallback} onRetry={onRetry} />
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
