import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { hederaMainnet, hederaTestnet } from "./chains";

/**
 * Wagmi config — EVM-flavoured wallet support only (MetaMask, plus HashPack and Blade
 * when running in their EVM/EIP-1193 modes). Native HashConnect (non-EVM HashPack)
 * is a future addition; the EVM path covers ~all production users in 2026 because
 * both HashPack and Blade ship EIP-1193 providers now.
 *
 * Reads use the configured Hashio RPC; writes go through the connected wallet's
 * signer. We keep the config single-network (mainnet) by default and let users
 * opt into testnet via a separate page or env override.
 */
export const wagmiConfig = createConfig({
  chains: [hederaMainnet, hederaTestnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [hederaMainnet.id]: http(),
    [hederaTestnet.id]: http(),
  },
  ssr: true,
});
