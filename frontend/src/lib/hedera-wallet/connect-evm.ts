/**
 * Helpers for the EVM wallet path (MetaMask / Rabby / OKX / Brave / any
 * `window.ethereum`-injected wallet). Hedera-native wallets are handled
 * separately by the DAppConnector in `provider.tsx`.
 *
 * Two responsibilities:
 *   1. Trigger `wagmi.connect({ connector: injected() })` from a UI click
 *   2. If the wallet is on the wrong chain, request a switch to Hedera
 *      mainnet (`eip155:295`), adding the chain to the wallet if it's not
 *      already configured.
 */

import { HEDERA_MAINNET_CHAIN_ID } from "@/lib/wagmi";

const HEDERA_RPC =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://mainnet.hashio.io/api";
const HEDERA_CHAIN_HEX = `0x${HEDERA_MAINNET_CHAIN_ID.toString(16)}` as const;

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
  return eth ?? null;
}

export function isInjectedWalletAvailable(): boolean {
  return getProvider() !== null;
}

/**
 * Ask the injected wallet to switch to Hedera mainnet. If the chain isn't
 * configured yet (`wallet_switchEthereumChain` returns error 4902), add it
 * first via `wallet_addEthereumChain` and then switch.
 *
 * Returns true if the wallet is on (or just moved to) Hedera mainnet.
 */
export async function ensureHederaMainnet(): Promise<boolean> {
  const eth = getProvider();
  if (!eth) return false;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: HEDERA_CHAIN_HEX }],
    });
    return true;
  } catch (err: unknown) {
    // Error 4902 = "Unrecognized chain ID" → add it then retry.
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: HEDERA_CHAIN_HEX,
              chainName: "Hedera Mainnet",
              nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
              rpcUrls: [HEDERA_RPC],
              blockExplorerUrls: ["https://hashscan.io/mainnet"],
            },
          ],
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
