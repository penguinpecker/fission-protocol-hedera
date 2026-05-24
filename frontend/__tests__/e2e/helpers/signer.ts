/**
 * Server-side signing helper.
 *
 * The page-injected mock provider can't import viem at runtime (the
 * injection happens before the React bundle loads), so signing requests
 * are forwarded to a Node-side helper via Playwright's `page.exposeFunction`.
 *
 * Loads operator key the same way scripts/smoke-e2e-all-routes.mjs does
 * (env first, then SEED_PHRASE derivation). The key NEVER leaves Node —
 * only the resulting raw signature/hash crosses into the page context.
 */

import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseTransaction,
  type Hex,
} from "viem";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnv(): void {
  const candidates = [".env", "../.env", "../../.env"];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "utf8").split("\n")) {
      const t = l.trim();
      if (!t || t.startsWith("#")) continue;
      const e = t.indexOf("=");
      if (e < 0) continue;
      const k = t.slice(0, e).trim();
      let v = t.slice(e + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
    return;
  }
}

function deriveKey(): string {
  loadEnv();
  if (process.env.HEDERA_OPERATOR_KEY) return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/, "");
  const s = process.env.SEED_PHRASE;
  if (!s) throw new Error("E2E: neither HEDERA_OPERATOR_KEY nor SEED_PHRASE set");
  if (!validateMnemonic(s, wordlist)) throw new Error("E2E: invalid SEED_PHRASE");
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(s)).derive(
    process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0",
  );
  if (!child.privateKey) throw new Error("E2E: derive failed");
  return Buffer.from(child.privateKey).toString("hex");
}

export const HEDERA_MAINNET = defineChain({
  id: 295,
  name: "Hedera Mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hashio.io/api"] } },
});

export interface SignerContext {
  account: LocalAccount;
  walletClient: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
  privateKeyHex: `0x${string}`;
  address: `0x${string}`;
}

export function createSignerContext(): SignerContext {
  const hex = deriveKey().replace(/^0x/, "");
  const privateKeyHex = `0x${hex}` as `0x${string}`;
  const account = privateKeyToAccount(privateKeyHex);
  const walletClient = createWalletClient({
    chain: HEDERA_MAINNET,
    transport: http("https://mainnet.hashio.io/api"),
    account,
  });
  const publicClient = createPublicClient({
    chain: HEDERA_MAINNET,
    transport: http("https://mainnet.hashio.io/api"),
  });
  return { account, walletClient, publicClient, privateKeyHex, address: account.address as `0x${string}` };
}

/**
 * Handler for the page's `window.__fissionMockSign(method, params)` calls.
 * Returns the EXACT shape MetaMask would return — a raw hex string for
 * eth_sendTransaction (the tx hash), an EIP-191 signature for personal_sign.
 */
export async function mockSign(
  ctx: SignerContext,
  method: string,
  params: unknown[],
): Promise<string> {
  switch (method) {
    case "personal_sign": {
      // params = [message, address]. Message is hex-encoded utf-8 OR plain string.
      const message = params[0] as string;
      const decoded = message.startsWith("0x")
        ? Buffer.from(message.slice(2), "hex").toString("utf8")
        : message;
      return await ctx.account.signMessage({ message: decoded });
    }
    case "eth_sendTransaction": {
      // params = [{ from, to, data, value, gas, gasPrice }]
      const tx = params[0] as {
        from?: string;
        to?: `0x${string}`;
        data?: `0x${string}`;
        value?: `0x${string}`;
        gas?: `0x${string}`;
      };
      const hash = await ctx.walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : undefined,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      });
      return hash;
    }
    default:
      throw new Error(`mockSign: unsupported method ${method}`);
  }
}
