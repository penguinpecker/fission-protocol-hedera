import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { hederaMainnet } from "./chains";

/**
 * Wagmi config — Hedera mainnet, two wallet paths:
 *
 *   1) HashPack / Kabila / Blade / any Hedera-native wallet via the
 *      `@hashgraph/hedera-wallet-connect` DAppConnector (NOT wired through
 *      wagmi — see `lib/hedera-wallet/provider.tsx`). Supports BOTH ECDSA
 *      and Ed25519 keys, since the `hedera:mainnet` namespace speaks HAPI
 *      protobuf instead of EVM.
 *
 *   2) MetaMask / Rabby / OKX / any browser-injected EVM wallet via the
 *      `injected()` connector here. ECDSA-only — these wallets cannot sign
 *      Ed25519. They talk directly to `window.ethereum` over DOM
 *      postMessage, so they bypass WalletConnect entirely.
 *
 * The two paths share no state — `injected()` doesn't touch WalletConnect
 * v2 session storage, so the rehydrate collision documented below doesn't
 * apply here.
 *
 * Why no wagmi `walletConnect` connector: wagmi's WC connector instantiates
 * `@walletconnect/ethereum-provider` which shares WC v2 session storage
 * (`wc@2:client:0.3//session`) with the Hedera DAppConnector. On every page
 * mount EthereumProvider tries to rehydrate the Hedera-namespace session,
 * fails on `setChainIds(undefined)` because there's no `eip155` namespace,
 * swallows the error and calls `disconnect()` — wiping the Hedera session
 * as a side effect. Mobile-MetaMask-via-WC support would need a second WC
 * v2 client with explicit storage isolation; defer until there's demand.
 *
 * Required env: NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is still used by
 * the Hedera DAppConnector (lib/hedera-wallet/provider.tsx), just not
 * here.
 */
export const HEDERA_MAINNET_CHAIN_ID = 295;

export const wagmiConfig = createConfig({
  chains: [hederaMainnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [hederaMainnet.id]: http(),
  },
  ssr: true,
});
