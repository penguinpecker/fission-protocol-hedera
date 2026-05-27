"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId } from "wagmi";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { LockIcon } from "@/components/Icons";
import { diag } from "@/lib/diag";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { WalletPicker } from "@/components/WalletPicker";

/**
 * Wraps content that should only render when a wallet is connected. We
 * gate on the unified `useWalletAdapter` so either path (legacy EVM
 * session restored, or fresh Hedera-native connect) lets users through.
 *
 * UI is intentionally minimal: a single "Connect" button → Reown's WC
 * modal → user picks any Hedera wallet (HashPack/Kabila/Blade) → modal
 * negotiates the `hedera:mainnet` namespace which accepts both Ed25519
 * and ECDSA keys.
 */
export function WalletGate({ children }: { children: React.ReactNode }) {
  const adapter = useWalletAdapter();
  const wagmi = useAccount();
  const chainId = useChainId();
  const hedera = useHederaWallet();

  const hederaAvailable = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

  // Hooks must be called unconditionally on every render — the `pickerOpen`
  // state was previously declared AFTER the early returns below, which made
  // the hook count vary across renders (rule-of-hooks violation → React error
  // #310 once a connected user transitions back to disconnected). Pinning it
  // to the top of the component fixes it.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Diag — one event per state transition for server-side tailing.
  const lastSnapshotRef = useRef<string>("");
  useEffect(() => {
    const snap = JSON.stringify({
      mode: adapter.mode,
      isConnected: adapter.isConnected,
      address: adapter.address,
      hederaStatus: hedera.status,
      chainId,
    });
    if (snap !== lastSnapshotRef.current) {
      lastSnapshotRef.current = snap;
      diag("WalletGate", {
        mode: adapter.mode,
        isConnected: adapter.isConnected,
        address: adapter.address,
        accountId: adapter.accountId,
        chainId,
        hederaStatus: hedera.status,
        hederaError: hedera.error,
        gateDecision:
          adapter.isConnected && adapter.address
            ? "render-children"
            : hedera.status === "connecting" || wagmi.status === "reconnecting"
              ? "skeleton"
              : "connect-prompt",
      });
    }
  }, [adapter, hedera, wagmi.status, chainId]);

  if (
    adapter.isConnected &&
    adapter.address &&
    (adapter.mode === "hedera" || chainId === HEDERA_MAINNET_CHAIN_ID)
  ) {
    return <>{children}</>;
  }

  if (hedera.status === "connecting" || wagmi.status === "reconnecting") {
    return (
      <section className="mx-auto min-h-[60vh] max-w-[520px] px-6 py-20">
        <div className="h-32 animate-pulse rounded-2xl border border-border bg-bgCard" />
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-[60vh] max-w-[560px] flex-col items-center px-6 py-20 text-center">
      <div className="mb-8 inline-flex size-14 items-center justify-center rounded-2xl border border-borderHover bg-white/[0.04]">
        <LockIcon className="size-7 text-text" />
      </div>

      <h1 className="text-[32px] font-light leading-[1.1] tracking-[-1px]">
        Connect your wallet to continue
      </h1>

      <p className="mt-4 text-[14.5px] leading-relaxed text-textSec">
        The markets read live PT, YT, and LP balances and route trades through your wallet. Fission only operates on Hedera mainnet (chain {HEDERA_MAINNET_CHAIN_ID}).
      </p>

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        disabled={!hederaAvailable}
        className="mt-8 rounded-xl bg-white px-9 py-[14px] text-[14px] font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Connect wallet
      </button>

      <p className="mt-4 text-[12px] text-textDim">
        HashPack (Hedera-native) or MetaMask (EVM via Hashio). Both ECDSA and Ed25519 account types
        supported on the HashPack side.
      </p>

      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />

      {hedera.error && (
        <div className="mt-6 max-w-[460px] rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left text-[12px] leading-relaxed text-warning">
          <div className="font-mono text-[10px] uppercase tracking-[1.5px]">Connect failed</div>
          <div className="mt-1 break-words font-mono">{hedera.error}</div>
        </div>
      )}
    </section>
  );
}
