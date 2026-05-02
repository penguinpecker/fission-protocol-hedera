import { defineChain } from "viem";

/**
 * Hedera mainnet (chainId 295). Hashio is documented as dev/test only — production
 * apps should use Validation Cloud or Arkhia (per Hedera docs and our Architecture
 * doc). For local dev / preview Hashio is fine.
 *
 * The block explorer is HashScan, which uses Hedera ID format (`0.0.NNN`) by default
 * but accepts EVM-address links too via the contract page.
 */
export const hederaMainnet = defineChain({
  id: 295,
  name: "Hedera Mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? "https://mainnet.hashio.io/api"] },
  },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/mainnet" },
  },
  testnet: false,
});

export const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_TESTNET_RPC_URL ?? "https://testnet.hashio.io/api"] },
  },
  blockExplorers: {
    default: { name: "HashScan Testnet", url: "https://hashscan.io/testnet" },
  },
  testnet: true,
});
