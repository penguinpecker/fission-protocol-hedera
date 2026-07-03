"use client";

/**
 * Landing-hero primary CTA. Adapts to the SHARED wallet state so it stays in
 * lock-step with the Nav's Connect/Sign button (both read the same
 * useSiweAuth + useWalletAdapter, both open the same shared WalletPicker):
 *   - disconnected        → "Connect Wallet" → opens the shared picker
 *   - connected, idle SIWE → "Sign In"       → manual SIWE (no auto-sign)
 *   - signed in           → "Open the markets" → Link to /markets
 *
 * Auto-sign was removed: connecting no longer fires SIWE automatically. The
 * post-auth redirect is centralized in WalletUiProvider and armed here on a
 * user-initiated Sign In.
 */

import Link from "next/link";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { useWalletUi } from "@/components/WalletUiProvider";

export function HeroCta() {
  const adapter = useWalletAdapter();
  const hedera = useHederaWallet();
  const { state: auth, signIn } = useSiweAuth();
  const { openPicker, armRedirect } = useWalletUi();

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

  // Wallet connected, SIWE not yet done → manual Sign In.
  if (adapter.isConnected && adapter.address) {
    return (
      <button
        type="button"
        onClick={() => {
          armRedirect();
          void signIn();
        }}
        disabled={auth.status === "loading"}
        className={baseClass}
      >
        {auth.status === "loading" ? "Signing…" : "Sign In"}
      </button>
    );
  }

  // Disconnected → open the shared picker (HashPack / MetaMask). Same modal +
  // state as the Nav button.
  return (
    <button
      type="button"
      onClick={openPicker}
      disabled={hedera.initializing || hedera.status === "connecting"}
      className={baseClass}
    >
      {hedera.initializing
        ? "Initializing…"
        : hedera.status === "connecting"
          ? "Opening…"
          : "Connect Wallet"}
    </button>
  );
}
