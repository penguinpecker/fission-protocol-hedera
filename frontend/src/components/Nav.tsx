"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnect, useSwitchChain } from "wagmi";
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
  const { connectors, connect, isPending: isEvmConnecting, error: evmError } = useConnect();
  const { switchChain } = useSwitchChain();
  const { state: auth, signIn, signOut } = useSiweAuth();
  const hedera = useHederaWallet();

  // Dropdown state for the dual-mode picker.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

  // EVM-only chain mismatch banner. Hedera-native mode doesn't have a
  // "wrong chain" notion — the session is bound to hedera:mainnet at negotiate.
  const onWrongChain =
    adapter.mode === "evm" &&
    wagmiAcct.isConnected &&
    chainId !== HEDERA_MAINNET_CHAIN_ID;
  useEffect(() => {
    if (onWrongChain) switchChain({ chainId: HEDERA_MAINNET_CHAIN_ID });
  }, [onWrongChain, switchChain]);

  const wcConnector = connectors[0];
  const evmAvailable = Boolean(wcConnector);
  const hederaAvailable = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

  const handleConnectEvm = () => {
    setPickerOpen(false);
    if (!wcConnector) return;
    connect({ connector: wcConnector, chainId: HEDERA_MAINNET_CHAIN_ID });
  };
  const handleConnectHedera = async () => {
    setPickerOpen(false);
    await hedera.connect();
  };
  const handleDisconnect = async () => {
    if (auth.status === "authenticated") await signOut();
    await adapter.disconnect();
  };

  const isConnecting = isEvmConnecting || hedera.status === "connecting";
  const connectErrorMsg =
    hedera.error ?? (evmError ? evmError.message : null);

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
            <div ref={pickerRef} className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                disabled={isConnecting}
                className="rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isConnecting ? "Connecting…" : "Connect"}
              </button>

              {pickerOpen && (
                <div className="absolute right-0 mt-2 w-[300px] overflow-hidden rounded-xl border border-border bg-bgCard shadow-2xl">
                  <div className="border-b border-border px-3 py-2 text-[10px] uppercase tracking-[1px] text-textDim">
                    Choose wallet path
                  </div>

                  <button
                    type="button"
                    onClick={handleConnectHedera}
                    disabled={!hederaAvailable}
                    className="block w-full border-b border-border px-3 py-3 text-left transition hover:bg-white/[0.04] disabled:opacity-40"
                  >
                    <div className="text-[13px] font-medium text-text">
                      Hedera native{" "}
                      <span className="ml-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[1px] text-success">
                        recommended
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-textDim">
                      Any HashPack / Kabila / Blade account — Ed25519 OR ECDSA. Most accounts work.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={handleConnectEvm}
                    disabled={!evmAvailable}
                    className="block w-full px-3 py-3 text-left transition hover:bg-white/[0.04] disabled:opacity-40"
                  >
                    <div className="text-[13px] font-medium text-text">EVM only</div>
                    <div className="mt-0.5 text-[11px] text-textDim">
                      HashPack/Kabila with EVM mode enabled, or MetaMask with Hedera mainnet added. ECDSA keys only.
                    </div>
                  </button>
                </div>
              )}
            </div>
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
