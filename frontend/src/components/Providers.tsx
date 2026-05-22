"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useEffect, useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { HederaWalletProvider } from "@/lib/hedera-wallet/provider";

// One-time localStorage purge for the stale wagmi v2 shim entries left
// over from when we shipped `injected({ shimDisconnect: true })`. The shim
// re-emitted connect/disconnect events on every page load and clashed with
// the Hedera DAppConnector's WC v2 storage, looping our hooks (React #300
// "Maximum update depth exceeded"). The purge runs once per browser, then
// remembers it ran so future sessions don't re-trigger it.
function useWagmiShimPurge() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const KEY = "fission_wagmi_purge_v1";
    if (localStorage.getItem(KEY)) return;
    try {
      // wagmi v2 prefixes its keys with "wagmi.". Drop only those so we
      // don't touch the Hedera WC v2 session.
      const wagmiKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("wagmi.")) wagmiKeys.push(k);
      }
      for (const k of wagmiKeys) localStorage.removeItem(k);
    } catch {
      /* localStorage unavailable — ignore */
    }
    localStorage.setItem(KEY, "1");
  }, []);
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  useWagmiShimPurge();

  // reconnectOnMount={false} prevents wagmi from auto-recovering an injected
  // (window.ethereum) session on page load. Otherwise wagmi would race the
  // Hedera DAppConnector during hydration, double-claim "connected", and
  // loop our adapter-mode-derived hooks. Users explicitly click "MetaMask"
  // in the picker to opt in.
  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <HederaWalletProvider>{children}</HederaWalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
