import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { hederaMainnet } from "./chains";

/**
 * Wagmi config.
 *
 * - Hedera mainnet only.
 * - Single EIP-6963 `injected` connector targeting MetaMask. We deliberately
 *   do NOT use `walletConnect()` or `metaMask()` (the latter pulls in
 *   @metamask/sdk which falls back to WC).
 *
 * Why injected-only for the EVM path: wagmi's WC connector instantiates
 * @walletconnect/ethereum-provider which shares WC v2 session storage
 * (`wc@2:client:0.3//session`) with the Hedera DAppConnector. On every
 * page mount, EthereumProvider tries to rehydrate the Hedera-namespace
 * session, fails on `setChainIds(undefined)` because there's no `eip155`
 * namespace, swallows the error and calls `disconnect()` — wiping the
 * Hedera session as a side effect (see commit 401a001 rollback for the
 * forensic trail). The injected EIP-6963 provider uses `window.ethereum`
 * directly with no WC plumbing, so there's no storage collision and both
 * wallets can coexist.
 *
 * Net effect: HashPack lives in `lib/hedera-wallet/provider.tsx`
 * (DAppConnector via Hedera-namespace WC). MetaMask lives here
 * (injected/EIP-6963). The adapter at `lib/hedera-wallet/adapter.ts`
 * picks the active one with first-connected-wins semantics.
 *
 * Required env: NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is still used by
 * the Hedera DAppConnector (HashPack), but not by anything in this file.
 */
export const HEDERA_MAINNET_CHAIN_ID = 295;

export const wagmiConfig = createConfig({
  chains: [hederaMainnet],
  connectors: [
    injected({
      target: "metaMask",
      shimDisconnect: true,
    }),
  ],
  transports: {
    [hederaMainnet.id]: http(),
  },
  ssr: true,
});

/**
 * `wallet_addEthereumChain` parameters for MetaMask, passed to wagmi's
 * `switchChain({ chainId, addEthereumChainParameter })`. We hardcode the
 * PUBLIC Hashio RPC here (the canonical chainlist.org/chain/295 endpoint)
 * rather than reuse `hederaMainnet.rpcUrls` — the app's own read RPC may be a
 * keyed/private endpoint (Arkhia/Validation Cloud) that must NOT be handed to
 * the user's MetaMask. Matches the ethereum-lists canonical entry: HBAR with
 * 18 decimals (the JSON-RPC weibar representation), HashScan explorer.
 * `chainId` is supplied by wagmi from the switch target — do not add it here.
 */
export const HEDERA_ADD_PARAMS = {
  chainName: "Hedera Mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: ["https://mainnet.hashio.io/api"],
  blockExplorerUrls: ["https://hashscan.io/mainnet"],
};
