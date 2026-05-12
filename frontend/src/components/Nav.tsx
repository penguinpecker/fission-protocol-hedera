"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { FissionLogo } from "./FissionLogo";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

export function Nav() {
  const adapter = useWalletAdapter();
  const wagmiAcct = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { state: auth, signIn, signOut } = useSiweAuth();
  const hedera = useHederaWallet();

  // EVM-only chain mismatch banner kept for the unlikely case the user
  // restored a legacy wagmi session. Hedera-native mode doesn't have a
  // "wrong chain" notion — the session is bound to hedera:mainnet at negotiate.
  const onWrongChain =
    adapter.mode === "evm" &&
    wagmiAcct.isConnected &&
    chainId !== HEDERA_MAINNET_CHAIN_ID;
  useEffect(() => {
    if (onWrongChain) switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID });
  }, [onWrongChain, switchChain]);

  const hederaAvailable = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

  // Single connect path: Reown's WC modal via DAppConnector. The modal
  // surfaces HashPack, Kabila, Blade, and any other WC-capable wallet,
  // and the hedera:mainnet namespace accepts both Ed25519 and ECDSA.
  const handleConnect = async () => {
    await hedera.connect();
  };
  const handleDisconnect = async () => {
    if (auth.status === "authenticated") await signOut();
    await adapter.disconnect();
  };

  const isConnecting = hedera.status === "connecting";
  const connectErrorMsg = hedera.error;

  return (
    <>
      <nav className="sticky top-0 z-50 flex items-center justify-between border-b border-border bg-bg/80 px-8 py-3 backdrop-blur">
        <Link href="/" className="flex items-center gap-2.5">
          <FissionLogo size={26} />
          <span className="text-[17px] font-semibold tracking-tight text-text">Fission</span>
        </Link>

        <div className="flex items-center gap-6">
          <Link href="/markets" className="text-[13px] font-medium text-textSec hover:text-text">
            Markets
          </Link>

          {adapter.isConnected && adapter.address ? (
            auth.status === "authenticated" ? (
              <div className="flex items-center gap-3">
                <Link href="/profile" className="text-[13px] font-medium text-textSec hover:text-text">
                  Profile
                </Link>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="flex items-center gap-1.5 rounded-[10px] border border-borderHover bg-white/[0.04] px-3.5 py-1.5 font-mono text-xs text-text"
                >
                  <span className="size-[5px] rounded-full bg-success" />
                  {adapter.mode === "hedera" && adapter.accountId
                    ? adapter.accountId
                    : shortAddr(adapter.address)}
                </button>
              </div>
            ) : auth.status === "loading" ? (
              <button
                type="button"
                disabled
                className="rounded-[10px] bg-white/10 px-5 py-2 text-[13px] font-semibold text-textSec"
              >
                Signing…
              </button>
            ) : (
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-xs text-textSec">
                  {adapter.mode === "hedera" && adapter.accountId
                    ? adapter.accountId
                    : shortAddr(adapter.address)}
                </span>
                {auth.status === "error" && (
                  <span
                    title={auth.error}
                    className="max-w-[200px] truncate rounded border border-warning/30 bg-warning/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[1px] text-warning"
                  >
                    {auth.error}
                  </span>
                )}
                <button
                  type="button"
                  onClick={signIn}
                  disabled={onWrongChain}
                  className="rounded-[10px] bg-white px-4 py-1.5 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
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
              className="rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isConnecting ? "Opening modal…" : "Connect"}
            </button>
          )}
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
        <div className="border-b border-warning/30 bg-warning/10 px-8 py-2 text-center text-[11px] font-mono text-warning">
          Connect failed: {connectErrorMsg.slice(0, 160)}
        </div>
      )}
    </>
  );
}
