"use client";

import { useEffect, useRef } from "react";
import { useAccount, useConnect, useChainId, useDisconnect } from "wagmi";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { LockIcon } from "@/components/Icons";
import { diag } from "@/lib/diag";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";

/**
 * Wraps content that should only render when a wallet is connected — via
 * EITHER the wagmi EVM path OR the Hedera-native path. Three failure states:
 *   1. Nothing connected — show picker (EVM + Hedera native).
 *   2. EVM session exists but no account (HashPack returned Array(0)) —
 *      show diagnostic + suggest Kabila / Hedera-native path.
 *   3. EVM connected on wrong chain — banner + auto-switch.
 */
export function WalletGate({ children }: { children: React.ReactNode }) {
  const adapter = useWalletAdapter();
  const wagmi = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending: isEvmConnecting, error: evmConnectError, reset: resetConnect } =
    useConnect();
  const { disconnect: disconnectEvm } = useDisconnect();
  const hedera = useHederaWallet();

  const wcConnector = connectors[0];
  const hederaAvailable = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

  // Diag: emit one event per state transition.
  const lastSnapshotRef = useRef<string>("");
  useEffect(() => {
    const snap = JSON.stringify({
      mode: adapter.mode,
      isConnected: adapter.isConnected,
      address: adapter.address,
      hederaStatus: hedera.status,
      evmStatus: wagmi.status,
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
        evmStatus: wagmi.status,
        connectError: evmConnectError?.message ?? hedera.error ?? null,
        gateDecision:
          adapter.isConnected && adapter.address
            ? "render-children"
            : hedera.status === "connecting" || wagmi.status === "connecting" || wagmi.status === "reconnecting"
              ? "skeleton"
              : wagmi.isConnected && !wagmi.address
                ? "no-account-diag"
                : "connect-picker",
      });
    }
  }, [adapter, hedera, wagmi, chainId, evmConnectError]);

  // EVM-mode chain-mismatch UI is handled by the Nav banner; the gate just
  // accepts any connected adapter (Hedera-native is mainnet-pinned by session).
  if (adapter.isConnected && adapter.address && (adapter.mode === "hedera" || chainId === HEDERA_MAINNET_CHAIN_ID)) {
    return <>{children}</>;
  }

  if (
    hedera.status === "connecting" ||
    wagmi.status === "connecting" ||
    wagmi.status === "reconnecting"
  ) {
    return (
      <section className="mx-auto min-h-[60vh] max-w-[520px] px-6 py-20">
        <div className="h-32 animate-pulse rounded-2xl border border-border bg-bgCard" />
      </section>
    );
  }

  // EVM-side edge case: wagmi has a session but no account (HashPack returned
  // empty accounts because no ECDSA account is active).
  const sessionWithoutAccount = wagmi.isConnected && !wagmi.address;
  const isEmptyAccountsError =
    !!evmConnectError &&
    /no accounts|empty array|did not authorize|user rejected/i.test(evmConnectError.message || "");

  const onConnectEvm = () => {
    if (!wcConnector) return;
    resetConnect();
    connect({ connector: wcConnector, chainId: HEDERA_MAINNET_CHAIN_ID });
  };
  const onConnectHedera = async () => {
    resetConnect();
    await hedera.connect();
  };
  const onReset = () => {
    resetConnect();
    void disconnectEvm();
  };

  return (
    <section className="mx-auto flex min-h-[60vh] max-w-[600px] flex-col items-center px-6 py-20 text-center">
      <div className="mb-8 inline-flex size-14 items-center justify-center rounded-2xl border border-borderHover bg-white/[0.04]">
        <LockIcon className="size-7 text-text" />
      </div>

      <h1 className="text-[32px] font-light leading-[1.1] tracking-[-1px]">
        {sessionWithoutAccount || isEmptyAccountsError
          ? "Wallet connected — no EVM account exposed"
          : "Connect your wallet to continue"}
      </h1>

      {sessionWithoutAccount || isEmptyAccountsError ? (
        <>
          <p className="mt-4 text-[14.5px] leading-relaxed text-textSec">
            Your wallet completed the EVM handshake but didn&apos;t share an account. <span className="text-text">Use the Hedera native path instead</span> — it works for both Ed25519 and ECDSA accounts and doesn&apos;t require EVM mode in HashPack.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onReset}
              className="rounded-xl border border-borderHover bg-white/[0.04] px-5 py-3 text-[13px] font-medium text-text transition hover:bg-white/[0.08]"
            >
              Disconnect EVM
            </button>
            <button
              type="button"
              onClick={onConnectHedera}
              disabled={!hederaAvailable}
              className="rounded-xl bg-white px-7 py-3 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
            >
              Connect Hedera native
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-[14.5px] leading-relaxed text-textSec">
            The markets read live PT, YT, and LP balances and route trades through your wallet. Fission only operates on Hedera mainnet (chain {HEDERA_MAINNET_CHAIN_ID}).
          </p>

          <div className="mt-8 flex w-full max-w-[420px] flex-col gap-3">
            <button
              type="button"
              onClick={onConnectHedera}
              disabled={!hederaAvailable}
              className="rounded-xl bg-white px-8 py-[14px] text-[14px] font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Hedera native (recommended)
            </button>
            <span className="text-[11px] text-textDim">
              Works with any HashPack / Kabila / Blade account — Ed25519 or ECDSA.
            </span>

            <button
              type="button"
              onClick={onConnectEvm}
              disabled={isEvmConnecting || !wcConnector}
              className="rounded-xl border border-borderHover bg-white/[0.04] px-8 py-[14px] text-[14px] font-medium text-text transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isEvmConnecting ? "Connecting…" : "EVM only"}
            </button>
            <span className="text-[11px] text-textDim">
              ECDSA accounts via HashPack/Kabila EVM mode or MetaMask.
            </span>
          </div>

          {evmConnectError && !isEmptyAccountsError && (
            <div className="mt-6 max-w-[460px] rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left text-[12px] leading-relaxed text-warning">
              <div className="font-mono text-[10px] uppercase tracking-[1.5px]">EVM connect failed</div>
              <div className="mt-1 break-words font-mono">{evmConnectError.message}</div>
            </div>
          )}
          {hedera.error && (
            <div className="mt-6 max-w-[460px] rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left text-[12px] leading-relaxed text-warning">
              <div className="font-mono text-[10px] uppercase tracking-[1.5px]">Hedera native connect failed</div>
              <div className="mt-1 break-words font-mono">{hedera.error}</div>
            </div>
          )}
        </>
      )}

      {adapter.isConnected && adapter.address && adapter.mode === "evm" && chainId !== HEDERA_MAINNET_CHAIN_ID && (
        <p className="mt-6 rounded-lg border border-error/30 bg-error/10 px-4 py-2 text-[12px] text-error">
          Connected on chain {chainId}. Switch to Hedera Mainnet ({HEDERA_MAINNET_CHAIN_ID}) to continue — see the banner at the top of the page.
        </p>
      )}
    </section>
  );
}
