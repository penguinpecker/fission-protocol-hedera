"use client";

import { useAccount, useConnect, useChainId, useDisconnect } from "wagmi";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { LockIcon } from "@/components/Icons";

/**
 * Wraps content that should only render when a wallet is connected to Hedera
 * mainnet. Renders a centered prompt otherwise. Distinguishes three failure
 * states so a stuck user knows what to do:
 *   1. Nothing connected — show Connect button.
 *   2. WC session exists but wallet returned zero accounts (HashPack without
 *      EVM-mode-enabled selected account, etc.) — show diagnostic message + reset.
 *   3. Connected on wrong chain — show switch-network banner (also shown in Nav).
 */
export function WalletGate({ children }: { children: React.ReactNode }) {
  const { isConnected, address, status } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending, error: connectError, reset: resetConnect } = useConnect();
  const { disconnect } = useDisconnect();
  const wcConnector = connectors[0];

  if (isConnected && address && chainId === HEDERA_MAINNET_CHAIN_ID) {
    return <>{children}</>;
  }

  // wagmi considers a session "reconnecting" while it tries to restore state
  // from storage at boot. Show a thin skeleton instead of the connect prompt
  // so we don't flash the prompt for users who are actually connected.
  if (status === "reconnecting" || status === "connecting") {
    return (
      <section className="mx-auto min-h-[60vh] max-w-[520px] px-6 py-20">
        <div className="h-32 animate-pulse rounded-2xl border border-border bg-bgCard" />
      </section>
    );
  }

  // Edge case: wagmi reports connected but no address. Means the wallet
  // accepted the session but didn't share an EVM account. Common with
  // HashPack when no EVM-enabled account is active.
  const sessionWithoutAccount = isConnected && !address;
  // The OTHER common case: wagmi rejected the connection entirely because
  // the wallet returned an empty accounts array — useConnect.error captures
  // this and isConnected stays false. Detect by message.
  const isEmptyAccountsError =
    !!connectError &&
    /no accounts|empty array|did not authorize|user rejected/i.test(connectError.message || "");

  const handleConnect = () => {
    if (!wcConnector) return;
    resetConnect();
    connect({ connector: wcConnector, chainId: HEDERA_MAINNET_CHAIN_ID });
  };

  const handleReset = () => {
    resetConnect();
    disconnect();
  };

  return (
    <section className="mx-auto flex min-h-[60vh] max-w-[560px] flex-col items-center px-6 py-20 text-center">
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
            Your wallet handshake completed but it didn&apos;t share an EVM account with the dApp. This usually means:
          </p>
          <ul className="mt-3 space-y-2 text-left text-[13px] text-textSec">
            <li>
              <span className="text-text">HashPack:</span> open the extension and switch to an EVM-enabled account. EVM mode must be ON in settings.
            </li>
            <li>
              <span className="text-text">Kabila:</span> works out of the box — pick it next try.
            </li>
            <li>
              <span className="text-text">Blade:</span> currently does not advertise Hedera EVM via WalletConnect — use HashPack or Kabila instead.
            </li>
          </ul>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={handleReset}
              className="rounded-xl border border-borderHover bg-white/[0.04] px-5 py-3 text-[13px] font-medium text-text transition hover:bg-white/[0.08]"
            >
              Disconnect &amp; try again
            </button>
            <button
              type="button"
              onClick={handleConnect}
              disabled={isPending || !wcConnector}
              className="rounded-xl bg-white px-7 py-3 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Connecting…" : "Reconnect"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-[14.5px] leading-relaxed text-textSec">
            The markets read your live PT, YT, and LP balances and route trades through your wallet. Fission only operates on Hedera mainnet (chain {HEDERA_MAINNET_CHAIN_ID}).
          </p>
          <button
            type="button"
            onClick={handleConnect}
            disabled={isPending || !wcConnector}
            className="mt-8 rounded-xl bg-white px-8 py-[14px] text-[14px] font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Connecting…" : "Connect via WalletConnect"}
          </button>
          <p className="mt-5 text-[12px] text-textDim">
            HashPack &middot; Kabila &middot; (Blade WIP) &mdash; via Reown WalletConnect.
          </p>

          {connectError && !isEmptyAccountsError && (
            <div className="mt-6 max-w-[460px] rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left text-[12px] leading-relaxed text-warning">
              <div className="font-mono text-[10px] uppercase tracking-[1.5px]">
                Connect failed
              </div>
              <div className="mt-1 break-words font-mono">{connectError.message}</div>
            </div>
          )}
        </>
      )}

      {isConnected && address && chainId !== HEDERA_MAINNET_CHAIN_ID && (
        <p className="mt-6 rounded-lg border border-error/30 bg-error/10 px-4 py-2 text-[12px] text-error">
          Connected on chain {chainId}. Switch to Hedera Mainnet ({HEDERA_MAINNET_CHAIN_ID}) to continue — see the banner at the top of the page.
        </p>
      )}
    </section>
  );
}
