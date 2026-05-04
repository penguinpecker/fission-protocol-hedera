#!/usr/bin/env node
// Verify wallet import: derive the EVM address from SEED_PHRASE (or use the
// preset HEDERA_OPERATOR_KEY) and check it on Hedera mainnet/testnet via RPC
// + Mirror Node. Prints ONLY the public address and balance — never the seed
// or private key.

import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function abort(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ─── Load .env directly (don't rely on shell `source` — seed phrases with
//     spaces/apostrophes break naive sourcing). Plain KEY=VALUE parsing.
function loadDotenv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Don't overwrite if the caller already set it in their shell.
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}
loadDotenv();

let privKeyBytes;

const seedPhrase = (process.env.SEED_PHRASE ?? "").trim();
const directKey = (process.env.HEDERA_OPERATOR_KEY ?? "").trim();

if (seedPhrase) {
  if (!validateMnemonic(seedPhrase, wordlist)) abort("SEED_PHRASE is not a valid BIP-39 mnemonic.");
  const path = (process.env.HEDERA_DERIVATION_PATH ?? "m/44'/3030'/0'/0/0").trim();
  const seed = mnemonicToSeedSync(seedPhrase);
  const child = HDKey.fromMasterSeed(seed).derive(path);
  if (!child.privateKey) abort(`Derivation at path '${path}' produced no private key.`);
  privKeyBytes = child.privateKey;
} else if (directKey) {
  const hex = directKey.startsWith("0x") ? directKey.slice(2) : directKey;
  if (hex.length !== 64) abort("HEDERA_OPERATOR_KEY must be a 0x-prefixed 64-hex-char ECDSA key.");
  privKeyBytes = Uint8Array.from(Buffer.from(hex, "hex"));
} else {
  abort("Neither SEED_PHRASE nor HEDERA_OPERATOR_KEY is set. Fill in .env first.");
}

// Derive uncompressed public key, then the EVM address (last 20 bytes of keccak256(pubkey[1:])).
const pubKey = secp256k1.getPublicKey(privKeyBytes, false); // 65 bytes, 0x04 || X || Y
const hash = keccak_256(pubKey.slice(1));
const evmAddr = "0x" + Buffer.from(hash.slice(-20)).toString("hex");

const network = (process.env.HEDERA_NETWORK ?? "testnet").toLowerCase();
const rpcUrl = network === "mainnet"
  ? (process.env.HEDERA_MAINNET_RPC ?? "https://mainnet.hashio.io/api")
  : (process.env.HEDERA_TESTNET_RPC ?? "https://testnet.hashio.io/api");
const mirrorUrl = network === "mainnet"
  ? "https://mainnet-public.mirrornode.hedera.com"
  : "https://testnet.mirrornode.hedera.com";

console.log(`\n──────────────────────────────────────────────`);
console.log(` Wallet verification — ${network.toUpperCase()}`);
console.log(`──────────────────────────────────────────────`);
console.log(` Source            : ${seedPhrase ? "SEED_PHRASE (derived)" : "HEDERA_OPERATOR_KEY (direct)"}`);
if (seedPhrase) console.log(` Derivation path   : ${process.env.HEDERA_DERIVATION_PATH ?? "m/44'/3030'/0'/0/0"}`);
console.log(` EVM address       : ${evmAddr}`);
console.log(` RPC               : ${rpcUrl}`);
console.log(` Mirror Node       : ${mirrorUrl}`);
console.log(`──────────────────────────────────────────────`);

// ─── 1) RPC sanity: chainId + balance + nonce ───
async function rpcCall(method, params = []) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

try {
  const chainId = await rpcCall("eth_chainId");
  const balanceWei = BigInt(await rpcCall("eth_getBalance", [evmAddr, "latest"]));
  const nonce = parseInt(await rpcCall("eth_getTransactionCount", [evmAddr, "latest"]), 16);

  // Hedera EVM uses 18-decimal balance display; 1 HBAR = 1e18 wei (despite tinybar = 1e8).
  const hbar = Number(balanceWei) / 1e18;

  console.log(` chainId           : ${parseInt(chainId, 16)} ${parseInt(chainId, 16) === 295 ? "(Hedera mainnet)" : parseInt(chainId, 16) === 296 ? "(Hedera testnet)" : "(unexpected)"}`);
  console.log(` Balance           : ${hbar.toFixed(6)} HBAR`);
  console.log(` Nonce             : ${nonce}`);
  console.log(`──────────────────────────────────────────────`);

  // ─── 2) Mirror Node — confirm Hedera account exists ───
  try {
    const mirror = await fetch(`${mirrorUrl}/api/v1/accounts/${evmAddr}`);
    if (mirror.status === 200) {
      const data = await mirror.json();
      console.log(` Hedera account ID : ${data.account ?? "(none)"}`);
      console.log(` EVM alias status  : ${data.evm_address ? "linked" : "no alias yet"}`);
      console.log(` Auto-renew        : ${data.auto_renew_period ?? "default"}s`);
    } else if (mirror.status === 404) {
      console.log(` Hedera account ID : ─ (account not yet created on chain — fund it to materialize)`);
    } else {
      console.log(` Mirror Node       : HTTP ${mirror.status} (skipped)`);
    }
  } catch (e) {
    console.log(` Mirror Node       : unreachable (${e.message})`);
  }

  console.log(`──────────────────────────────────────────────\n`);

  // ─── 3) Sanity guards ───
  if (hbar === 0) {
    console.log(`⚠️  Balance is 0 HBAR. Fund this address before deploying.`);
    if (network === "testnet") {
      console.log(`    Testnet faucet: https://portal.hedera.com → drip 1000 HBAR free.`);
    } else {
      console.log(`    Mainnet: buy HBAR on Coinbase / Binance / etc. and send to this address.`);
      console.log(`    Plan ~10 HBAR for the v1 deploy (factory + 2 markets + SY adapters).`);
    }
  } else if (network === "mainnet" && hbar < 10) {
    console.log(`⚠️  Balance is ${hbar.toFixed(2)} HBAR — below the ~10 HBAR mainnet deploy estimate.`);
  } else {
    console.log(`✅ Wallet imported, RPC reachable, balance sufficient for deploy.`);
  }
} catch (e) {
  console.error(`\nRPC error: ${e.message}`);
  console.error(`Check that ${rpcUrl} is reachable from your network.`);
  process.exit(1);
}
