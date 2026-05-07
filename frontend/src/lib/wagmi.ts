import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { hederaMainnet, hederaTestnet } from "./chains";

/**
 * Wagmi config — multi-wallet connectors for Hedera.
 *
 * Two connection paths:
 *
 * 1. **WalletConnect** — the universal Hedera path. HashPack mobile + HashPack
 *    extension + Blade + Kabila all support WalletConnect v2; user scans a QR
 *    or picks the wallet from Reown's modal. Requires
 *    `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (free signup at cloud.reown.com).
 *    Without that env var the connector is omitted and only injected EVM
 *    wallets (e.g. MetaMask) work.
 *
 * 2. **Injected (EIP-1193)** — for browser extensions that auto-inject
 *    `window.ethereum`. HashPack 2024+ does NOT inject by default — only when
 *    "EVM mode" is toggled on in extension settings. So in practice this lane
 *    catches MetaMask + any user who's enabled HashPack/Blade EVM mode.
 *
 * Listing WalletConnect first means it shows up at the top of the wallet
 * picker — users with HashPack-no-EVM-mode see WalletConnect and connect
 * via QR.
 */
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// wagmi's `Target` accepts a wallet-flag string OR a custom `{id, name, provider}`
// triple. HashPack / Blade aren't in wagmi's flag list, so we return the triple.
// Their providers conform to EIP-1193 at runtime; the unknown→provider cast is
// the minimum-surface-area path that keeps TS happy without `any`.
//
// Future cleanup (v1.1): the deprecated WalletProviderFlags union was sunset
// 2024/10/16 in favour of EIP-6963 multi-injected discovery. Switching to the
// EIP-6963 connector eliminates the cast entirely.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderShape = any;

function detectProvider(detect: () => unknown): ProviderShape {
  if (typeof window === "undefined") return undefined;
  return detect();
}

export const wagmiConfig = createConfig({
  chains: [hederaMainnet, hederaTestnet],
  connectors: [
    // WalletConnect first — works with HashPack/Blade/Kabila on every OS,
    // including HashPack extension when EVM mode is OFF. Skipped at config
    // time if no projectId is set so we don't initialize a broken connector.
    ...(wcProjectId
      ? [
          walletConnect({
            projectId: wcProjectId,
            metadata: {
              name: "Fission Protocol",
              description: "Yield-stripping AMM on Hedera",
              url: "https://www.fissionp.com",
              icons: ["https://www.fissionp.com/icon.png"],
            },
            showQrModal: true,
          }),
        ]
      : []),
    // Injected paths — kept for HashPack/Blade users who've enabled EVM mode
    // in their extension settings, and for MetaMask.
    injected({
      shimDisconnect: true,
      target() {
        return {
          id: "hashpack",
          name: "HashPack (EVM mode)",
          provider: detectProvider(() => {
            const w = window as unknown as {
              hashpack?: unknown;
              ethereum?: { isHashPack?: boolean };
            };
            if (w.hashpack) return w.hashpack;
            if (w.ethereum?.isHashPack) return w.ethereum;
            return undefined;
          }),
        };
      },
    }),
    injected({
      shimDisconnect: true,
      target() {
        return {
          id: "blade",
          name: "Blade Wallet (EVM mode)",
          provider: detectProvider(() => {
            const w = window as unknown as {
              bladeWallet?: unknown;
              ethereum?: { isBlade?: boolean };
            };
            if (w.bladeWallet) return w.bladeWallet;
            if (w.ethereum?.isBlade) return w.ethereum;
            return undefined;
          }),
        };
      },
    }),
    injected({ shimDisconnect: true, target: "metaMask" }),
    // Generic fallback — listed last so named wallets show first in the picker.
    injected({ shimDisconnect: true }),
  ],
  transports: {
    [hederaMainnet.id]: http(),
    [hederaTestnet.id]: http(),
  },
  ssr: true,
});
