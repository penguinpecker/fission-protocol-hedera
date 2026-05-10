import { createConfig, http } from "wagmi";
import { walletConnect } from "wagmi/connectors";
import { hederaMainnet } from "./chains";

/**
 * Wagmi config — WalletConnect only, Hedera mainnet only.
 *
 * Why not injected EVM connectors? Hedera-native wallets (HashPack, Blade,
 * Kabila) speak the WalletConnect v2 protocol. Injected paths require the
 * user to flip "EVM mode" in their wallet settings, which most users miss
 * and which makes the picker confusing. WalletConnect Reown modal handles
 * QR-scan + extension-deep-link uniformly.
 *
 * Why mainnet only? The protocol is HTS-native and lives on chain 295.
 * Letting users connect to the wrong chain (Hedera testnet, or random EVMs
 * via MetaMask) creates support tickets and lost funds. The connect button
 * forces 295 at session-time; if a wallet refuses, the connect simply fails
 * with a clear error, not a wrong-chain trap.
 *
 * Required env: NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (free at cloud.reown.com).
 * If unset, the connect button is disabled — the app does not fall back to a
 * bad-experience injected mode.
 */
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const HEDERA_MAINNET_CHAIN_ID = 295;

export const wagmiConfig = createConfig({
  chains: [hederaMainnet],
  connectors: wcProjectId
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
    : [],
  transports: {
    [hederaMainnet.id]: http(),
  },
  ssr: true,
});
