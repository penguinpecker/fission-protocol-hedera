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
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { useEffect, useRef } from "react";

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

  // Fully disconnected → kick off the combined Connect & Sign chain.
  return (
    <button
      type="button"
      onClick={async () => {
        autoSignAfterConnectRef.current = true;
        redirectAfterAuthRef.current = true;
        await hedera.connect();
      }}
      disabled={hedera.status === "connecting"}
      className={baseClass}
    >
      {hedera.status === "connecting" ? "Opening…" : "Connect & Sign"}
    </button>
  );
}
