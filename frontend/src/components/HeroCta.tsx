"use client";

/**
 * Landing-hero primary CTA. Adapts to wallet state:
 *   - disconnected  → "Connect & Sign", triggers the same Connect flow as Nav
 *   - connected, idle SIWE → "Sign In", triggers SIWE
 *   - signed in    → "Open the markets", Link to /markets
 *
 * In every connect/sign path, the post-auth redirect-to-/markets is armed
 * (matching Nav's redirectAfterAuthRef behaviour) so the user lands on the
 * markets page once the wallet hand-shake finishes.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConnect } from "wagmi";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { useEffect, useRef, useState } from "react";
import {
  ensureHederaMainnet,
  isInjectedWalletAvailable,
} from "@/lib/hedera-wallet/connect-evm";

export function HeroCta() {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const { state: auth, signIn } = useSiweAuth();
  const router = useRouter();

  // Refs gate the post-click flow so a session-restore (which silently flips
  // auth → authenticated without any user action) doesn't bounce the user
  // out of whatever page they're on.
  const autoSignAfterConnectRef = useRef(false);
  const redirectAfterAuthRef = useRef(false);

  // Auto-trigger SIWE once the wallet finishes connecting from a CTA click.
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

  // Redirect to /markets once SIWE lands, but only from a CTA-initiated flow.
  useEffect(() => {
    if (auth.status === "authenticated" && redirectAfterAuthRef.current) {
      redirectAfterAuthRef.current = false;
      router.push("/markets");
    }
  }, [auth.status, router]);

  const baseClass =
    "rounded-xl bg-white px-7 py-[13px] text-[14px] font-semibold text-bg transition hover:opacity-90 sm:px-9 sm:py-[15px] sm:text-[15px] disabled:cursor-not-allowed disabled:opacity-60";

  // Already signed in → straight nav.
  if (adapter.isConnected && adapter.address && auth.status === "authenticated") {
    return (
      <Link href="/markets" className={baseClass}>
        Open the markets
      </Link>
    );
  }

  // Wallet connected, SIWE not yet done.
  if (adapter.isConnected && adapter.address) {
    return (
      <button
        type="button"
        onClick={() => {
          redirectAfterAuthRef.current = true;
          void signIn();
        }}
        disabled={auth.status === "loading"}
        className={baseClass}
      >
        {auth.status === "loading" ? "Signing…" : "Sign In"}
      </button>
    );
  }

  // Fully disconnected → show the wallet picker (Hedera vs EVM).
  return <DisconnectedCta
    baseClass={baseClass}
    onPickHedera={async () => {
      autoSignAfterConnectRef.current = true;
      redirectAfterAuthRef.current = true;
      await hedera.connect();
    }}
    hederaPending={hedera.status === "connecting"}
  />;
}

function DisconnectedCta({
  baseClass,
  onPickHedera,
  hederaPending,
}: {
  baseClass: string;
  onPickHedera: () => Promise<void>;
  hederaPending: boolean;
}) {
  const wagmiConnect = useConnect();
  const [open, setOpen] = useState(false);
  const injectedAvailable = isInjectedWalletAvailable();

  const onPickEvm = async () => {
    setOpen(false);
    try {
      const connector = wagmiConnect.connectors.find((c) => c.id === "injected");
      if (!connector) return;
      await wagmiConnect.connectAsync({ connector });
      await ensureHederaMainnet();
    } catch {
      /* user rejected or wallet unavailable */
    }
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={hederaPending || wagmiConnect.isPending}
        className={baseClass}
      >
        {hederaPending || wagmiConnect.isPending ? "Opening…" : "Connect Wallet"}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-1/2 top-[calc(100%+8px)] z-50 w-[280px] -translate-x-1/2 rounded-md border border-borderHover bg-bg/95 p-1.5 text-left shadow-lg backdrop-blur-sm">
            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                await onPickHedera();
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded-[3px] px-3 py-2.5 transition hover:bg-white/[0.06]"
            >
              <span className="text-[13px] font-semibold text-text">
                Hedera Wallet
              </span>
              <span className="font-mono text-[10px] text-textDim">
                HashPack · Kabila · Blade (Ed25519 + ECDSA)
              </span>
            </button>
            <button
              type="button"
              onClick={onPickEvm}
              disabled={!injectedAvailable}
              className="flex w-full flex-col items-start gap-0.5 rounded-[3px] px-3 py-2.5 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-[13px] font-semibold text-text">
                EVM Wallet
              </span>
              <span className="font-mono text-[10px] text-textDim">
                {injectedAvailable
                  ? "MetaMask · Rabby · OKX (ECDSA only)"
                  : "No browser wallet detected"}
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
