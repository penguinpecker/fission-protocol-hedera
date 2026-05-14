"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";

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
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { state: auth, signIn, signOut } = useSiweAuth();
  const hedera = useHederaWallet();

  const onWrongChain =
    adapter.mode === "evm" &&
    wagmiAcct.isConnected &&
    chainId !== HEDERA_MAINNET_CHAIN_ID;
  useEffect(() => {
    if (onWrongChain) switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID });
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
  const handleConnect = async () => {
    autoSignAfterConnectRef.current = true;
    redirectAfterAuthRef.current = true;
    await hedera.connect();
  };
  const handleDisconnect = async () => {
    if (auth.status === "authenticated") await signOut();
    await adapter.disconnect();
  };

  // When the wallet has just connected AND the user clicked our Connect button
  // (not a session restore), fire SIWE automatically.
  useEffect(() => {
    if (
      autoSignAfterConnectRef.current &&
      adapter.isConnected &&
      adapter.address &&
      auth.status === "idle"
    ) {
      autoSignAfterConnectRef.current = false;
      void signIn();
    }
  }, [adapter.isConnected, adapter.address, auth.status, signIn]);

  // Redirect to /markets ONCE, only after a click-initiated Connect & Sign
  // chain finishes. Probes that flip state to "authenticated" (eg. /api/auth/me
  // on a refresh, or visiting /profile while a cookie is live) do NOT trigger
  // this — the ref isn't set in those paths.
  useEffect(() => {
    if (auth.status === "authenticated" && redirectAfterAuthRef.current) {
      redirectAfterAuthRef.current = false;
      if (!pathname.startsWith("/markets")) {
        router.push("/markets");
      }
    }
  }, [auth.status, pathname, router]);

  const isConnecting = hedera.status === "connecting";
  const connectErrorMsg = hedera.error;

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // Mobile hamburger menu — links are hidden below md: so phone users had
  // no way to reach /whitepaper or /profile from the header. Toggle closes
  // automatically when the route changes.
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

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
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="inline-flex items-center gap-1.5 rounded-[2px] border border-borderHover bg-white/[0.04] px-3.5 py-2 font-mono text-[12px] text-text transition hover:bg-white/[0.06]"
                >
                  <span className="size-[5px] rounded-full bg-success" />
                  {adapter.mode === "hedera" && adapter.accountId
                    ? adapter.accountId
                    : shortAddr(adapter.address)}
                </button>
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
                    onClick={signIn}
                    disabled={onWrongChain}
                    className="rounded-[2px] border border-white bg-white px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:opacity-50"
                  >
                    {auth.status === "error" ? "Try again" : "Sign In"}
                  </button>
                </div>
              )
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={isConnecting || !hederaAvailable}
                title={
                  !hederaAvailable
                    ? "WalletConnect not configured (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID missing)"
                    : "Two HashPack popups, back-to-back: 1) connect, 2) sign in. Then we land you on /markets."
                }
                className="rounded-[2px] border border-white bg-white px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isConnecting
                  ? "Opening…"
                  : autoSignAfterConnectRef.current && auth.status === "loading"
                    ? "Signing…"
                    : "Connect & Sign"}
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
            onClick={() => switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID })}
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
