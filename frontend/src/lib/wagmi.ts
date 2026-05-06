import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { hederaMainnet, hederaTestnet } from "./chains";

/**
 * Wagmi config — multi-wallet EVM connectors for Hedera.
 *
 * Each supported Hedera wallet exposes an EIP-1193 provider on `window.*`. We
 * declare a separate `injected` connector per wallet so the user sees ALL their
 * installed options in the wallet picker, instead of a generic "Connect" button
 * grabbing whichever provider loaded into `window.ethereum` first.
 *
 *   - **HashPack**: `window.hashpack` or `window.ethereum.isHashPack`
 *   - **Blade**:    `window.bladeWallet` or `window.ethereum.isBlade`
 *   - **MetaMask**: `window.ethereum.isMetaMask`
 *   - **Generic**:  fallback for any other EIP-1193 wallet
 *
 * HashPack and Blade both ship native EIP-1193 providers as of 2024+. Native
 * HashConnect (non-EVM) support is a separate path — left out here because both
 * HashPack and Blade users can connect via EVM with no UX downgrade.
 */

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
    injected({
      shimDisconnect: true,
      target() {
        return {
          id: "hashpack",
          name: "HashPack",
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
          name: "Blade Wallet",
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
