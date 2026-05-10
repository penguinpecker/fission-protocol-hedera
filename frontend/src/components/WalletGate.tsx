"use client";

import { useAccount, useConnect, useChainId } from "wagmi";
import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";
import { LockIcon } from "@/components/Icons";

/**
 * Wraps content that should only render when a wallet is connected to Hedera
 * mainnet. Renders a centered prompt otherwise.
 */
export function WalletGate({ children }: { children: React.ReactNode }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending } = useConnect();
  const wcConnector = connectors[0];

  if (isConnected && chainId === HEDERA_MAINNET_CHAIN_ID) {
    return <>{children}</>;
  }

  const handleConnect = () => {
    if (!wcConnector) return;
    connect({ connector: wcConnector, chainId: HEDERA_MAINNET_CHAIN_ID });
  };

  return (
    <section className="mx-auto flex min-h-[60vh] max-w-[520px] flex-col items-center px-6 py-20 text-center">
      <div className="mb-8 inline-flex size-14 items-center justify-center rounded-2xl border border-borderHover bg-white/[0.04]">
        <LockIcon className="size-7 text-text" />
      </div>

      <h1 className="text-[32px] font-light leading-[1.1] tracking-[-1px]">
        Connect your wallet to continue
      </h1>

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
        HashPack · Blade · Kabila — all via Reown WalletConnect.
      </p>

      {isConnected && chainId !== HEDERA_MAINNET_CHAIN_ID && (
        <p className="mt-6 rounded-lg border border-error/30 bg-error/10 px-4 py-2 text-[12px] text-error">
          Connected on chain {chainId}. Switch to Hedera Mainnet ({HEDERA_MAINNET_CHAIN_ID}) to continue — see the banner at the top of the page.
        </p>
      )}
    </section>
  );
}
