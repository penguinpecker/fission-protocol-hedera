"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { FissionLogo } from "./FissionLogo";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

export function Nav() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { state: auth, signIn, signOut } = useSiweAuth();

  // Single connector by config — WalletConnect when project ID is set, else none.
  const wcConnector = connectors[0];
  const wcAvailable = Boolean(wcConnector);

  // Auto-switch to Hedera mainnet whenever a connected wallet drifts off-chain.
  // Some wallets refuse the prompt; that case surfaces as a persistent banner.
  const onWrongChain = isConnected && chainId !== HEDERA_MAINNET_CHAIN_ID;
  useEffect(() => {
    if (onWrongChain) {
      switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID });
    }
  }, [onWrongChain, switchChain]);

  const handleConnect = () => {
    if (!wcConnector) return;
    connect({ connector: wcConnector, chainId: HEDERA_MAINNET_CHAIN_ID });
  };

  const handleDisconnect = async () => {
    if (auth.status === "authenticated") await signOut();
    disconnect();
  };

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

          {isConnected && address ? (
            auth.status === "authenticated" ? (
              <div className="flex items-center gap-3">
                <Link
                  href="/profile"
                  className="text-[13px] font-medium text-textSec hover:text-text"
                >
                  Profile
                </Link>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="flex items-center gap-1.5 rounded-[10px] border border-borderHover bg-white/[0.04] px-3.5 py-1.5 font-mono text-xs text-text"
                >
                  <span className="size-[5px] rounded-full bg-success" />
                  {shortAddr(address)}
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
                <span className="font-mono text-xs text-textSec">{shortAddr(address)}</span>
                <button
                  type="button"
                  onClick={signIn}
                  disabled={onWrongChain}
                  className="rounded-[10px] bg-white px-4 py-1.5 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
                >
                  Sign In
                </button>
              </div>
            )
          ) : (
            <button
              type="button"
              onClick={handleConnect}
              disabled={isPending || !wcAvailable}
              title={
                !wcAvailable
                  ? "WalletConnect not configured (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID missing)"
                  : "Connect via WalletConnect (HashPack, Blade, Kabila)"
              }
              className="rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Connecting…" : !wcAvailable ? "Wallet unavailable" : "Connect"}
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
    </>
  );
}
