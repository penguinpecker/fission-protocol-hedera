"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
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

  const handleConnect = async () => {
    await hedera.connect();
  };
  const handleDisconnect = async () => {
    if (auth.status === "authenticated") await signOut();
    await adapter.disconnect();
  };

  const isConnecting = hedera.status === "connecting";
  const connectErrorMsg = hedera.error;

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <>
      <nav className="sticky top-0 z-50 border-b border-border bg-black/65 backdrop-blur-[14px]">
        <div className="mx-auto flex h-[60px] max-w-[1440px] items-center justify-between gap-6 px-7">
          {/* Brand */}
          <Link href="/" className="flex items-center gap-3 font-semibold tracking-[0.02em]">
            <BrandOrbitLogo />
            <span className="text-[14.5px] leading-none text-text">
              FISSION
              <span className="mt-px block font-mono text-[10px] uppercase tracking-[0.18em] text-textDim">
                PROTOCOL · HEDERA
              </span>
            </span>
          </Link>

          {/* Center links */}
          <div className="hidden items-center gap-1 md:flex">
            <NavLink href="/" active={isActive("/")}>Home</NavLink>
            <NavLink href="/markets" active={isActive("/markets")}>Markets</NavLink>
            <NavLink href="/profile" active={isActive("/profile")}>Profile</NavLink>
            <NavLink href="https://github.com/penguinpecker/fission-protocol-hedera" external>
              Docs
            </NavLink>
            <NavLink
              href="https://github.com/penguinpecker/fission-protocol-hedera/tree/main/audits/internal"
              external
            >
              Audits
            </NavLink>
          </div>

          {/* Right cluster: chain-pill + connect / account */}
          <div className="flex items-center gap-2.5">
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
                    : "Opens WalletConnect modal — pick any Hedera wallet"
                }
                className="rounded-[2px] border border-white bg-white px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isConnecting ? "Opening…" : "Connect Wallet"}
              </button>
            )}
          </div>
        </div>
      </nav>

      {onWrongChain && (
        <div className="border-b border-error/30 bg-error/10 px-8 py-2 text-center text-[12px] text-error">
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
        <div className="border-b border-warning/30 bg-warning/10 px-8 py-2 text-center font-mono text-[11px] text-warning">
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
