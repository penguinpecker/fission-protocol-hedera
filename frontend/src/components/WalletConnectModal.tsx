"use client";

/**
 * Wallet picker modal — discrete row per wallet, "Detected" badge on
 * browser-injected wallets, centered overlay with backdrop. Mirrors the
 * SaucerSwap pattern so Hedera users land on familiar UX.
 *
 * Routing:
 *   - HashPack / Kabila / Blade   → hedera.connect() (DAppConnector WC modal)
 *   - WalletConnect (generic)     → hedera.connect() (same path, distinct
 *                                    visual entry for users who want to scan
 *                                    a code from any WC-compatible wallet)
 *   - MetaMask / EVM injected     → wagmi.connect(injected) + chain switch
 */

import { useEffect } from "react";
import { useConnect } from "wagmi";
import { useHederaWallet } from "@/lib/hedera-wallet/provider";
import {
  ensureHederaMainnet,
  isInjectedWalletAvailable,
} from "@/lib/hedera-wallet/connect-evm";

interface WalletConnectModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional callback invoked the instant a wallet method is picked. The
   *  parent uses this to arm the post-connect SIWE+redirect flow. */
  onPicked?: () => void;
}

export function WalletConnectModal({ open, onClose, onPicked }: WalletConnectModalProps) {
  const hedera = useHederaWallet();
  const wagmiConnect = useConnect();
  const injectedAvailable = isInjectedWalletAvailable();
  const hederaAvailable = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleHedera = async () => {
    onPicked?.();
    onClose();
    await hedera.connect();
  };

  const handleInjected = async () => {
    onPicked?.();
    onClose();
    try {
      const connector = wagmiConnect.connectors.find((c) => c.id === "injected");
      if (!connector) return;
      await wagmiConnect.connectAsync({ connector });
      await ensureHederaMainnet();
    } catch {
      /* user cancelled or wallet missing */
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label="Connect wallet"
      data-testid="wallet-connect-modal"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-[420px] overflow-hidden rounded-2xl border border-borderHover bg-bgCard shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <div className="text-[16px] font-semibold text-text">Connect Wallet</div>
            <div className="mt-1 text-[12.5px] text-textSec">
              Pick how you want to sign — Hedera-native or any EVM wallet.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-textDim transition hover:bg-white/[0.06] hover:text-text"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        {/* Wallet list */}
        <div className="flex flex-col gap-2 p-4">
          <WalletRow
            icon={<HashPackIcon />}
            name="HashPack"
            tag="Hedera-native · Ed25519 + ECDSA"
            disabled={!hederaAvailable}
            onClick={handleHedera}
          />
          <WalletRow
            icon={<KabilaIcon />}
            name="Kabila Wallet"
            tag="Hedera-native · Ed25519 + ECDSA"
            disabled={!hederaAvailable}
            onClick={handleHedera}
          />
          <WalletRow
            icon={<WalletConnectIcon />}
            name="WalletConnect"
            tag="Any Hedera WC-compatible wallet"
            disabled={!hederaAvailable}
            onClick={handleHedera}
          />
          <div className="my-1 flex items-center gap-3 px-1 text-[10px] uppercase tracking-[1.5px] text-textDim">
            <span className="h-px flex-1 bg-border" />
            EVM wallets (ECDSA only)
            <span className="h-px flex-1 bg-border" />
          </div>
          <WalletRow
            icon={<MetaMaskIcon />}
            name="MetaMask"
            tag={
              injectedAvailable
                ? "Browser extension detected"
                : "Browser extension not detected"
            }
            badge={injectedAvailable ? "Detected" : undefined}
            disabled={!injectedAvailable}
            onClick={handleInjected}
          />
          <WalletRow
            icon={<RabbyIcon />}
            name="Rabby / OKX / Brave"
            tag={
              injectedAvailable
                ? "Any other injected EVM wallet"
                : "No injected wallet detected"
            }
            disabled={!injectedAvailable}
            onClick={handleInjected}
          />
        </div>

        {/* Footer */}
        <div className="border-t border-border bg-black/30 px-6 py-3 text-[11px] text-textDim">
          Fission only operates on Hedera mainnet (chain 295). EVM wallets will
          be auto-prompted to switch.
        </div>
      </div>
    </div>
  );
}

function WalletRow({
  icon,
  name,
  tag,
  badge,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  name: string;
  tag: string;
  badge?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const testid = `wallet-row-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className="flex items-center gap-3 rounded-xl border border-border bg-white/[0.02] px-4 py-3 text-left transition hover:border-borderHover hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <div className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.06]">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-text">{name}</div>
        <div className="truncate font-mono text-[10.5px] text-textDim">{tag}</div>
      </div>
      {badge && (
        <span className="rounded-md bg-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1px] text-success">
          {badge}
        </span>
      )}
    </button>
  );
}

/* Inline SVG icons — kept simple and color-tinted to match the dark theme.
   We're not bundling brand logos to keep the install surface small. */

function HashPackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-text" fill="currentColor">
      <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" opacity="0.85" />
    </svg>
  );
}

function KabilaIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-text" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 6l8 12 8-12M4 18l8-12 8 12" />
    </svg>
  );
}

function WalletConnectIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-text" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M6 10c3-3 9-3 12 0M4 12.5c4-4 12-4 16 0M8 15c2-2 6-2 8 0" />
    </svg>
  );
}

function MetaMaskIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-warning" fill="currentColor">
      <path d="M3 4l8 5-1.5-4L3 4zm18 0l-8 5 1.5-4L21 4zM5 17l3 1 1-2-4-2 0 3zm14 0l-3 1-1-2 4-2 0 3zM10 13l2 1 2-1-1 4-2 1-2-1-1-4 2 0z" opacity="0.9" />
    </svg>
  );
}

function RabbyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-text" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="8" />
      <path d="M8 11c1-1 2-1 4 0s3 1 4 0M9 14c1 1 4 1 6 0" />
    </svg>
  );
}
