import { createConfig, http } from "wagmi";
import { hederaMainnet } from "./chains";

/**
 * Wagmi config — read-only, Hedera mainnet only.
 *
 * No connectors. The dApp uses `@hashgraph/hedera-wallet-connect`'s
 * DAppConnector directly (see `lib/hedera-wallet/provider.tsx`) which
 * supports both ECDSA and Ed25519 accounts via the `hedera:mainnet`
 * namespace. Wagmi is retained ONLY for its read-side hooks
 * (`useReadContracts`, `useWaitForTransactionReceipt` in EVM mode, etc.)
 * over Hashio JSON-RPC.
 *
 * Why no wagmi `walletConnect` connector: wagmi's connector instantiates
 * `@walletconnect/ethereum-provider` which shares WC v2 session storage
 * (`wc@2:client:0.3//session`) with the Hedera DAppConnector. On every
 * page mount, EthereumProvider tries to rehydrate the Hedera-namespace
 * session, fails on `setChainIds(undefined)` because there's no
 * `eip155` namespace, swallows the error and calls `disconnect()` —
 * wiping the Hedera session as a side effect. Users had to reconnect
 * on every refresh. Dropping the connector removes the storage
 * collision entirely.
 *
 * Required env: NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is still used by
 * the Hedera DAppConnector (lib/hedera-wallet/provider.tsx), just not
 * here.
 */
export const HEDERA_MAINNET_CHAIN_ID = 295;

export const wagmiConfig = createConfig({
  chains: [hederaMainnet],
  connectors: [],
  transports: {
    [hederaMainnet.id]: http(),
  },
  ssr: true,
});
