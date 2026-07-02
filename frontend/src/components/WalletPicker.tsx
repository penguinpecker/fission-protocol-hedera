"use client";

/**
 * WalletPicker — modal triggered by the Connect button. Two options:
 *
 *   - HashPack: Hedera-native, supports ECDSA + Ed25519, opens via WC v2
 *     deeplink/QR. Uses `lib/hedera-wallet/provider.tsx`.
 *   - MetaMask: EVM-only (ECDSA via Hashio relay), opens via EIP-6963
 *     injected provider. Uses `lib/wagmi.ts` injected connector.
 *
 * No third option (Blade, Kabila) yet — additive when needed; each is a
 * 10-line patch since the adapter is wallet-agnostic.
 *
 * Once a wallet connects, SIWE auto-fires via the Nav's effect on
 * `adapter.isConnected` transitioning to `true`. The picker just kicks
 * off the connect; it doesn't track auth state itself.
 */

import { useEffect, useState } from "react";
import { useConnect } from "wagmi";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Called *after* a successful connect attempt is kicked off, before the
   * wallet popup resolves. The parent uses this to arm a one-shot
   * post-auth redirect.
   */
  onConnectStarted?: () => void;
}

export function WalletPicker({ open, onClose, onConnectStarted }: Props) {
  const hedera = useHederaWallet();
  const { connectors, connect, isPending: isWagmiConnecting, error: wagmiError } = useConnect();

  // Pick out the injected (MetaMask) connector if available.
  const metaMaskConnector = connectors.find((c) => c.id === "injected" || c.type === "injected");

  const [pickError, setPickError] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset error when re-opened.
  useEffect(() => { if (open) setPickError(null); }, [open]);

  // Close on successful wagmi connect.
  useEffect(() => {
    if (wagmiError) setPickError(wagmiError.message?.slice(0, 200) ?? "Connect failed");
  }, [wagmiError]);

  if (!open) return null;

  const handleHashPack = async () => {
    setPickError(null);
    onConnectStarted?.();
    // Close the picker BEFORE awaiting hedera.connect() — that call opens
    // the WalletConnect QR/deeplink modal, which would otherwise overlap
    // visually with our picker. Errors thrown by hedera.connect() will be
    // surfaced through the provider's error state on the next render.
    onClose();
    try {
      await hedera.connect();
    } catch (e) {
      // Picker is already closed; log to console for debugging but don't
      // try to re-open just to show the error.
      console.error("[WalletPicker] HashPack connect:", e);
    }
  };

  const handleMetaMask = async () => {
    setPickError(null);
    if (!metaMaskConnector) {
      setPickError("MetaMask connector not loaded. Refresh and retry.");
      return;
    }
    onConnectStarted?.();
    try {
      // Check that MetaMask (or another EIP-6963 wallet) is actually installed
      // by probing window.ethereum. If absent, surface a clear message
      // instead of letting wagmi throw a cryptic "user rejected" later.
      if (typeof window !== "undefined" && !(window as { ethereum?: unknown }).ethereum) {
        setPickError(
          "MetaMask not detected. Install the MetaMask browser extension from https://metamask.io and refresh."
        );
        return;
      }
      connect({ connector: metaMaskConnector });
      // wagmi's connect is async fire-and-forget; the Nav's effect on
      // `adapter.isConnected` will detect the connection and proceed to SIWE.
      // Close the modal optimistically — the user sees the MetaMask popup,
      // then either signs or cancels, then sees the Nav state update.
      onClose();
    } catch (e) {
      setPickError(e instanceof Error ? e.message.slice(0, 200) : String(e));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[min(420px,92vw)] rounded-2xl border border-border bg-bgCard p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-picker-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="wallet-picker-title" className="font-mono text-[14px] uppercase tracking-[1.5px] text-text">
            Connect a Wallet
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-textDim transition hover:bg-white/[0.06] hover:text-text"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        <p className="mb-5 text-[12px] leading-relaxed text-textSec">
          Pick your wallet. HashPack supports native Hedera accounts (ECDSA + Ed25519). MetaMask supports
          ECDSA-keyed Hedera accounts via the Hashio EVM relay.
        </p>

        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={handleHashPack}
            disabled={hedera.initializing || hedera.status === "connecting"}
            className="flex items-center justify-between rounded-[10px] border border-border bg-white/[0.04] px-4 py-3.5 text-left transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div>
              <div className="font-mono text-[13px] font-semibold uppercase tracking-[1.2px] text-text">
                HashPack
              </div>
              <div className="mt-0.5 text-[11px] text-textDim">Hedera-native · ECDSA + Ed25519</div>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-textDim">
              {hedera.initializing ? "Initializing…" : hedera.status === "connecting" ? "Opening…" : "Connect"}
            </span>
          </button>

          <button
            type="button"
            onClick={handleMetaMask}
            disabled={isWagmiConnecting || !metaMaskConnector}
            className="flex items-center justify-between rounded-[10px] border border-border bg-white/[0.04] px-4 py-3.5 text-left transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div>
              <div className="font-mono text-[13px] font-semibold uppercase tracking-[1.2px] text-text">
                MetaMask
              </div>
              <div className="mt-0.5 text-[11px] text-textDim">EVM · ECDSA only · via Hashio relay</div>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-textDim">
              {isWagmiConnecting ? "Opening…" : "Connect"}
            </span>
          </button>
        </div>

        {pickError && (
          <div className="mt-4 rounded-lg border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-error">
            {pickError}
          </div>
        )}

        <p className="mt-5 text-[10px] leading-relaxed text-textDim">
          MetaMask users connecting for the first time on Hedera: your account is auto-activated on its
          first signed transaction. If you see a "no balance" error, send any tiny HBAR amount to your
          MetaMask address first to promote the account.
        </p>
      </div>
    </div>
  );
}
