"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnect } from "wagmi";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { LockIcon } from "@/components/Icons";
import { diag } from "@/lib/diag";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import {
  ensureHederaMainnet,
  isInjectedWalletAvailable,
} from "@/lib/hedera-wallet/connect-evm";

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

  const wagmiConnect = useConnect();
  const injectedAvailable = isInjectedWalletAvailable();
  const [evmError, setEvmError] = useState<string | null>(null);

  const onConnectHedera = async () => {
    await hedera.connect();
  };
  const onConnectEvm = async () => {
    setEvmError(null);
    try {
      const connector = wagmiConnect.connectors.find((c) => c.id === "injected");
      if (!connector) throw new Error("No injected wallet connector available");
      await wagmiConnect.connectAsync({ connector });
      // After connecting, nudge the wallet to Hedera mainnet if it isn't
      // already there. Doesn't throw if user rejects — they'll see the
      // "wrong network" gate state and can switch manually.
      await ensureHederaMainnet();
    } catch (e) {
      setEvmError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="mx-auto flex min-h-[60vh] max-w-[640px] flex-col items-center px-6 py-20 text-center">
      <div className="mb-8 inline-flex size-14 items-center justify-center rounded-2xl border border-borderHover bg-white/[0.04]">
        <LockIcon className="size-7 text-text" />
      </div>

      <h1 className="text-[32px] font-light leading-[1.1] tracking-[-1px]">
        Connect your wallet to continue
      </h1>

      <p className="mt-4 text-[14.5px] leading-relaxed text-textSec">
        Pick how you want to sign — Hedera-native (HashPack / Kabila / Blade, supports Ed25519 + ECDSA) or any EVM wallet (MetaMask / Rabby / OKX). Fission only operates on Hedera mainnet (chain {HEDERA_MAINNET_CHAIN_ID}).
      </p>

      <div className="mt-8 grid w-full max-w-[520px] gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={onConnectHedera}
          disabled={!hederaAvailable}
          className="flex flex-col items-start gap-1 rounded-xl bg-white px-5 py-4 text-left text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-[14px] font-semibold">
            Hedera Wallet
          </span>
          <span className="text-[11px] font-normal opacity-70">
            HashPack · Kabila · Blade
          </span>
        </button>
        <button
          type="button"
          onClick={onConnectEvm}
          disabled={!injectedAvailable || wagmiConnect.isPending}
          className="flex flex-col items-start gap-1 rounded-xl border border-borderHover bg-white/[0.04] px-5 py-4 text-left text-text transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-[14px] font-semibold">
            {wagmiConnect.isPending ? "Opening…" : "EVM Wallet"}
          </span>
          <span className="text-[11px] font-normal text-textDim">
            {injectedAvailable
              ? "MetaMask · Rabby · OKX (ECDSA only)"
              : "No browser wallet detected"}
          </span>
        </button>
      </div>

      <p className="mt-4 text-[12px] text-textDim">
        Hedera-native wallets sign via WalletConnect. EVM wallets sign directly through your browser extension; we&apos;ll request a switch to Hedera mainnet if needed.
      </p>

      {hedera.error && (
        <div className="mt-6 max-w-[460px] rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left text-[12px] leading-relaxed text-warning">
          <div className="font-mono text-[10px] uppercase tracking-[1.5px]">Hedera connect failed</div>
          <div className="mt-1 break-words font-mono">{hedera.error}</div>
        </div>
      )}
      {evmError && (
        <div className="mt-3 max-w-[460px] rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left text-[12px] leading-relaxed text-warning">
          <div className="font-mono text-[10px] uppercase tracking-[1.5px]">EVM connect failed</div>
          <div className="mt-1 break-words font-mono">{evmError}</div>
        </div>
      )}
    </section>
  );
}
