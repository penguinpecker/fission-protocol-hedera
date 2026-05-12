"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { HederaWalletProvider } from "@/lib/hedera-wallet/provider";

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

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <HederaWalletProvider>{children}</HederaWalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
