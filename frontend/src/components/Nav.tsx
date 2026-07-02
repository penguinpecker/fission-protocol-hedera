"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { HEDERA_MAINNET_CHAIN_ID, HEDERA_ADD_PARAMS } from "@/lib/wagmi";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet, isInIframe } from "@/lib/hedera-wallet/provider";
import { WalletPicker } from "@/components/WalletPicker";

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

/**
 * Terminal-style navigation bar. Layout mirrors the reference template
 * (`markets.html` / `profile.html`): brand block on the left (animated orbit
 * SVG + "FISSION" with a mono "PROTOCOL · HEDERA" tagline), centered nav
 * links, and the right cluster of chain-pill + Connect/account button.
 *
 * Wallet plumbing — adapter, SIWE, chain-mismatch handling — is preserved
 * from the previous Nav; only the visual treatment changes.
 */
export function Nav() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const adapter = useWalletAdapter();
  const wagmiAcct = useAccount();
  const { switchChain } = useSwitchChain();
  const { state: auth, signIn, signOut } = useSiweAuth();
  const hedera = useHederaWallet();

  // NB: use the connector's ACTUAL chain (`useAccount().chainId`), NOT
  // `useChainId()`. The wagmi config only declares chain 295, so `useChainId()`
  // always returns 295 regardless of the wallet's real network — which made
  // onWrongChain permanently false and let SIWE fire while MetaMask was still
  // on Polygon/Ethereum. `wagmiAcct.chainId` reflects the wallet's true chain
  // (e.g. 137 Polygon) so the add+switch fires and the sign-gate holds.
  const onWrongChain =
    adapter.mode === "evm" &&
    wagmiAcct.isConnected &&
    wagmiAcct.chainId !== HEDERA_MAINNET_CHAIN_ID;
  useEffect(() => {
    if (onWrongChain) {
      // Auto-switch MetaMask to Hedera; addEthereumChainParameter makes the
      // injected connector fall back to wallet_addEthereumChain (with the
      // public Hashio RPC) when chain 295 isn't yet in the user's wallet.
      switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID, addEthereumChainParameter: HEDERA_ADD_PARAMS });
    }
  }, [onWrongChain, switchChain]);

  const hederaAvailable = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

  // One-click Connect → Sign-In flow.
  //
  // Without this, the user clicks Connect (1st popup) → connects → then clicks
  // Sign In (2nd popup) → signs. Now: click Connect → 1st popup → after the
  // wallet returns, we auto-trigger SIWE → 2nd popup fires immediately. One
  // user click, both signatures back-to-back. The ref distinguishes a
  // user-initiated connect (auto-sign) from a session-restore on page load
  // (don't auto-sign — that'd surprise users).
  // Two refs gate the auto-sign / redirect flow so they ONLY fire when the
  // user clicks our Connect button — never on session restore or on a
  // /api/auth/me probe that flips state to "authenticated" silently.
  //   - autoSignAfterConnectRef: trigger SIWE right after a click-initiated
  //     `hedera.connect()` succeeds.
  //   - redirectAfterAuthRef: redirect to /markets after the resulting SIWE
  //     verify lands. Cleared after one use so navigating to /profile later
  //     (with a still-valid cookie) doesn't bounce the user back to /markets.
  const autoSignAfterConnectRef = useRef(false);
  const redirectAfterAuthRef = useRef(false);
  // Picker modal — replaces the direct hedera.connect() call. Lets the user
  // pick between HashPack (Hedera-native WC) and MetaMask (EIP-6963 injected).
  // The picker calls back when a connect attempt is kicked off so this Nav
  // can arm the auto-sign + redirect refs (same effect as the prior
  // handleConnect did for HashPack-only).
  const [pickerOpen, setPickerOpen] = useState(false);
  const handleConnectStarted = () => {
    autoSignAfterConnectRef.current = true;
    redirectAfterAuthRef.current = true;
  };
  const handleDisconnect = async () => {
    if (auth.status === "authenticated") await signOut();
    await adapter.disconnect();
  };

  // When the wallet has just connected AND the user clicked our Connect button
  // (not a session restore), fire SIWE automatically.
  //
  // Order matters for MetaMask: we wait until the wallet is on Hedera before
  // prompting the signature. `!onWrongChain` blocks SIWE while the add+switch
  // (the onWrongChain effect above) is still pending, so the user sees the
  // MetaMask prompts in a clean sequence — add Hedera → switch → sign — instead
  // of a signature popup landing on the wrong chain mid-switch. For HashPack
  // (mode='hedera') onWrongChain is always false, so it's unaffected. The
  // autoSign ref stays armed until the chain is right, so a declined/slow
  // switch just defers the signature rather than dropping it.
  useEffect(() => {
    if (
      // Auto-sign after a click-initiated connect (autoSignAfterConnectRef), OR
      // whenever we're inside a wallet dapp-browser iframe (e.g. HashPack) — there
      // the wallet auto-connects on mount with no click, so without this the
      // "Sign In" button lingers even though the wallet is connected. Inside the
      // dapp browser a seamless auto-sign is the expected flow. Top-level loads
      // still only auto-sign after a user click (a restored session must NOT pop
      // a spontaneous signature prompt on every refresh).
      (autoSignAfterConnectRef.current || isInIframe()) &&
      adapter.isConnected &&
      adapter.address &&
      auth.status === "idle" &&
      !onWrongChain
    ) {
      autoSignAfterConnectRef.current = false;
      // Inside a wallet dapp browser (iframe) the connect+sign is auto-initiated
      // on entry — so also arm the one-shot redirect to land the user on /markets
      // after sign-in, matching the click-initiated flow. This only runs on a
      // fresh auto-sign (auth.status === "idle" above), so a passive reload with a
      // live session won't fire it; the redirect effect's pathname guard also
      // skips /markets and /claim.
      if (isInIframe()) redirectAfterAuthRef.current = true;
      void signIn();
    }
  }, [adapter.isConnected, adapter.address, auth.status, signIn, onWrongChain]);

  // Redirect to /markets ONCE, only after a click-initiated Connect & Sign
  // chain finishes. Probes that flip state to "authenticated" (eg. /api/auth/me
  // on a refresh, or visiting /profile while a cookie is live) do NOT trigger
  // this — the ref isn't set in those paths.
  useEffect(() => {
    if (auth.status === "authenticated" && redirectAfterAuthRef.current) {
      redirectAfterAuthRef.current = false;
      // /claim drives its own post-redeem redirect to /markets — don't yank the
      // user off the claim page the instant they sign in (before entering a code).
      if (!pathname.startsWith("/markets") && !pathname.startsWith("/claim")) {
        router.push("/markets");
      }
    }
  }, [auth.status, pathname, router]);

  const isConnecting = hedera.status === "connecting";
  const isInitializing = hedera.initializing;
  const connectErrorMsg = hedera.error;

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // Mobile hamburger menu — links are hidden below md: so phone users had
  // no way to reach /whitepaper or /profile from the header. Toggle closes
  // automatically when the route changes.
  const [mobileOpen, setMobileOpen] = useState(false);

  // Account dropdown (opened by clicking the connected wallet chip). Previously
  // the chip logged the user out on a single click, which was too easy to hit by
  // accident; now the click opens this menu and Log out is an explicit item.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  // Close the account dropdown on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const accountLabel =
    adapter.mode === "hedera" && adapter.accountId ? adapter.accountId : adapter.address ?? "";
  const copyAccount = async () => {
    if (!accountLabel) return;
    try {
      await navigator.clipboard.writeText(accountLabel);
      setCopiedAddr(true);
      setTimeout(() => setCopiedAddr(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  return (
    <>
      <nav className="sticky top-0 z-50 border-b border-border bg-black/65 backdrop-blur-[14px]">
        <div className="mx-auto flex h-[60px] max-w-[1440px] items-center justify-between gap-3 px-4 sm:gap-6 sm:px-6 md:px-7">
          {/* Brand — tagline hides on very narrow phones so the account chip
              still fits beside it without forcing the row to wrap. */}
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-[0.02em] sm:gap-3">
            <BrandOrbitLogo />
            <span className="text-[14.5px] leading-none text-text">
              FISSION
              <span className="mt-px hidden font-mono text-[10px] uppercase tracking-[0.18em] text-textDim sm:block">
                PROTOCOL · HEDERA
              </span>
            </span>
          </Link>

          {/* Center links */}
          <div className="hidden items-center gap-1 md:flex">
            <NavLink href="/" active={isActive("/")}>Home</NavLink>
            <NavLink href="/markets" active={isActive("/markets")}>Markets</NavLink>
            <NavLink href="/leaderboard" active={isActive("/leaderboard")}>Leaderboard</NavLink>
            <NavLink href="/referrals" active={isActive("/referrals")}>Referrals</NavLink>
            <NavLink href="/profile" active={isActive("/profile")}>Profile</NavLink>
            <NavLink href="/whitepaper" active={isActive("/whitepaper")}>Whitepaper</NavLink>
          </div>

          {/* Right cluster: chain-pill + connect / account + mobile menu btn */}
          <div className="flex flex-shrink-0 items-center gap-1.5 sm:gap-2.5">
            <span className="hidden items-center gap-2 rounded-[2px] border border-border px-2.5 py-1.5 font-mono text-[11px] text-textSec sm:inline-flex">
              <span className="term-pulse-dot inline-block size-[6px] rounded-full bg-white" />
              HEDERA · 295
            </span>

            {adapter.isConnected && adapter.address ? (
              auth.status === "authenticated" ? (
                <div className="relative" ref={menuRef}>
                  <button
                    type="button"
                    onClick={() => setMenuOpen((o) => !o)}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    className="inline-flex items-center gap-1.5 rounded-[2px] border border-borderHover bg-white/[0.04] px-3.5 py-2 font-mono text-[12px] text-text transition hover:bg-white/[0.06]"
                  >
                    <span className="size-[5px] rounded-full bg-success" />
                    {adapter.mode === "hedera" && adapter.accountId
                      ? adapter.accountId
                      : shortAddr(adapter.address)}
                    <svg
                      viewBox="0 0 12 12"
                      className={`size-3 text-textDim transition-transform ${menuOpen ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden
                    >
                      <path d="M3 4.5 6 7.5 9 4.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>

                  {menuOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 top-[calc(100%+6px)] z-50 w-[240px] overflow-hidden rounded-[4px] border border-border bg-bgCard shadow-2xl"
                    >
                      <div className="border-b border-border px-3.5 py-3">
                        <div className="font-mono text-[9px] uppercase tracking-[1.6px] text-textDim">
                          Connected · {adapter.mode === "hedera" ? "HashPack" : "MetaMask"}
                        </div>
                        <div className="mt-1.5 break-all font-mono text-[11.5px] leading-snug text-text">
                          {accountLabel}
                        </div>
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={copyAccount}
                        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left font-mono text-[11px] text-textSec transition hover:bg-white/[0.05]"
                      >
                        <span>Copy address</span>
                        <span className="text-[10px] text-textDim">{copiedAddr ? "Copied ✓" : ""}</span>
                      </button>
                      <Link
                        href="/profile"
                        role="menuitem"
                        onClick={() => setMenuOpen(false)}
                        className="flex w-full items-center px-3.5 py-2.5 text-left font-mono text-[11px] text-textSec transition hover:bg-white/[0.05]"
                      >
                        View profile
                      </Link>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          void handleDisconnect();
                        }}
                        className="flex w-full items-center gap-2 border-t border-border px-3.5 py-2.5 text-left font-mono text-[11px] text-error transition hover:bg-error/10"
                      >
                        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                          <path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6M10.5 11 14 8l-3.5-3M14 8H6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Log out
                      </button>
                    </div>
                  )}
                </div>
              ) : auth.status === "loading" ? (
                <button
                  type="button"
                  disabled
                  className="rounded-[2px] bg-white/10 px-4 py-2 text-[13px] font-medium text-textSec"
                >
                  Signing…
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="hidden font-mono text-[11px] text-textSec sm:inline">
                    {adapter.mode === "hedera" && adapter.accountId
                      ? adapter.accountId
                      : shortAddr(adapter.address)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      // Arm the post-auth redirect ref so the "Sign In" path
                      // (wallet already connected, just signing) lands on
                      // /markets like the combined Connect & Sign path does.
                      // Without this, only handleConnect would trigger the
                      // redirect and the standalone Sign In click silently
                      // stayed on whatever page the user was on.
                      redirectAfterAuthRef.current = true;
                      void signIn();
                    }}
                    disabled={onWrongChain}
                    className="rounded-[2px] border border-white bg-white px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:opacity-50"
                  >
                    {/* Same copy as the hero CTA — the two buttons share one auth
                        state and must read identically. A failed attempt just
                        means "sign in (again)", not different words. (This branch
                        never renders while status is "loading".) */}
                    Sign In
                  </button>
                </div>
              )
            ) : (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                disabled={isConnecting || isInitializing || !hederaAvailable}
                title={
                  !hederaAvailable
                    ? "WalletConnect not configured (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID missing)"
                    : "Pick HashPack or MetaMask; we'll auto-sign you in right after."
                }
                className="rounded-[2px] border border-white bg-white px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isInitializing
                  ? "Initializing…"
                  : isConnecting
                    ? "Opening…"
                    : autoSignAfterConnectRef.current && auth.status === "loading"
                      ? "Signing…"
                      : "Connect Wallet"}
              </button>
            )}

            <button
              type="button"
              aria-label="Toggle menu"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen((v) => !v)}
              className="inline-flex size-9 items-center justify-center rounded-[2px] border border-border text-text transition hover:bg-white/[0.04] md:hidden"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                {mobileOpen ? (
                  <>
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </>
                ) : (
                  <>
                    <line x1="4" y1="7" x2="20" y2="7" />
                    <line x1="4" y1="12" x2="20" y2="12" />
                    <line x1="4" y1="17" x2="20" y2="17" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="border-t border-border bg-black/80 backdrop-blur-[14px] md:hidden">
            <div className="mx-auto flex max-w-[1440px] flex-col gap-1 px-4 py-3 sm:px-6">
              <MobileNavLink href="/" active={isActive("/")}>Home</MobileNavLink>
              <MobileNavLink href="/markets" active={isActive("/markets")}>Markets</MobileNavLink>
              <MobileNavLink href="/leaderboard" active={isActive("/leaderboard")}>Leaderboard</MobileNavLink>
              <MobileNavLink href="/referrals" active={isActive("/referrals")}>Referrals</MobileNavLink>
              <MobileNavLink href="/profile" active={isActive("/profile")}>Profile</MobileNavLink>
              <MobileNavLink href="/whitepaper" active={isActive("/whitepaper")}>Whitepaper</MobileNavLink>
            </div>
          </div>
        )}
      </nav>

      {onWrongChain && (
        <div className="border-b border-error/30 bg-error/10 px-4 py-2 text-center text-[12px] text-error sm:px-8">
          Wrong network — Fission only operates on Hedera Mainnet (chain 295).{" "}
          <button
            type="button"
            onClick={() => switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID, addEthereumChainParameter: HEDERA_ADD_PARAMS })}
            className="underline underline-offset-2"
          >
            Switch network
          </button>
        </div>
      )}

      {connectErrorMsg && !adapter.isConnected && (
        <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-center font-mono text-[11px] text-warning sm:px-8">
          Connect failed: {connectErrorMsg.slice(0, 160)}
        </div>
      )}

      <WalletPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConnectStarted={handleConnectStarted}
      />
    </>
  );
}

function NavLink({
  href,
  active,
  external,
  children,
}: {
  href: string;
  active?: boolean;
  external?: boolean;
  children: React.ReactNode;
}) {
  const base =
    "rounded-[2px] border px-3.5 py-1.5 text-[13px] transition";
  const idle = "border-transparent text-textSec hover:bg-white/[0.04] hover:text-white";
  const on = "border-borderHover bg-white/[0.06] text-white";
  const cls = `${base} ${active ? on : idle}`;
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

function MobileNavLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const base =
    "rounded-[2px] border px-3 py-2.5 text-[14px] transition";
  const idle = "border-transparent text-textSec hover:bg-white/[0.04] hover:text-white";
  const on = "border-borderHover bg-white/[0.06] text-white";
  const cls = `${base} ${active ? on : idle}`;
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/**
 * Brand orbit logo — three rotating ellipses + a slow-pulsing nucleus. Lifted
 * from the reference template (32×32 viewBox 0 0 64 64). Animations are
 * declared inline so the component stays self-contained.
 */
function BrandOrbitLogo() {
  return (
    <span className="relative inline-block size-[30px] flex-shrink-0">
      <svg viewBox="0 0 64 64" className="block size-full">
        <g style={{ transformOrigin: "center", animation: "termSpin 12s linear infinite" }}>
          <ellipse cx="32" cy="32" rx="26" ry="9" fill="none" stroke="#fff" strokeWidth="1.4" />
        </g>
        <g style={{ transformOrigin: "center", animation: "termSpin 9s linear infinite" }}>
          <ellipse cx="32" cy="32" rx="26" ry="9" fill="none" stroke="#fff" strokeWidth="1.2" opacity="0.75" transform="rotate(60 32 32)" />
        </g>
        <g style={{ transformOrigin: "center", animation: "termSpin 9s linear infinite reverse" }}>
          <ellipse cx="32" cy="32" rx="26" ry="9" fill="none" stroke="#fff" strokeWidth="1.2" opacity="0.55" transform="rotate(120 32 32)" />
        </g>
        <circle cx="32" cy="32" r="3" fill="#fff" style={{ animation: "termNucleus 2.4s ease-in-out infinite" }} />
      </svg>
      <style>{`
        @keyframes termSpin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
        @keyframes termNucleus { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }
      `}</style>
    </span>
  );
}
