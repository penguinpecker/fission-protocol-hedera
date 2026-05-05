#!/usr/bin/env node
// Create a Hedera 2-of-2 threshold-key account for protocol governance.
//
// Usage:
//   node scripts/create-threshold-account.mjs \
//     <ECDSA_PUBKEY_A> \
//     <ECDSA_PUBKEY_B> \
//     [initial-hbar-balance=20]
//
// Each pubkey is a hex-encoded compressed ECDSA pubkey (66 chars: 02/03 prefix
// + 64 hex chars), or a Hedera DER-encoded ECDSA pubkey. If you pass a wallet
// EVM address (0x...) instead of a pubkey, the script fetches the pubkey
// from Mirror Node automatically.
//
// Emits the account ID + EVM alias to stdout. Save them to deployments/295.json
// under the `governance.threshold` key (deployer-side; the script does not
// auto-write to avoid clobbering any in-flight edits).

import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  KeyList,
  PublicKey,
  PrivateKey,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

function loadDotenv() {
  const envPath = join(REPO, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node scripts/create-threshold-account.mjs <pubkey_or_evm_a> <pubkey_or_evm_b> [hbar=20]");
  process.exit(1);
}

const initialHbar = Number(args[2] ?? "20");

async function resolvePubKey(input) {
  // Accept (a) DER-encoded pubkey hex (~88 chars), (b) compressed 33-byte hex, (c) 0x... EVM addr.
  const s = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    const res = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${s.toLowerCase()}`);
    if (!res.ok) throw new Error(`Mirror Node lookup for ${s} failed (${res.status})`);
    const data = await res.json();
    if (!data.key?.key) throw new Error(`No key returned for ${s} — account may be uncreated.`);
    return PublicKey.fromString(data.key.key);
  }
  // Try ECDSA from raw / DER hex
  return PublicKey.fromStringECDSA(s.replace(/^0x/, ""));
}

const pkA = await resolvePubKey(args[0]);
const pkB = await resolvePubKey(args[1]);
const thresholdKey = new KeyList([pkA, pkB], 2);

// Operator (deployer EOA) pays for the create.
function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!seed) throw new Error("Set SEED_PHRASE or HEDERA_OPERATOR_KEY");
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());

let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr) {
  const evm = "0x" + operatorKey.publicKey.toEvmAddress();
  const res = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evm}`);
  operatorIdStr = (await res.json()).account;
}

const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

console.log("Creating 2-of-2 threshold account…");
console.log(`  Operator (payer): ${operatorIdStr}`);
console.log(`  Pubkey A:         ${pkA.toString()}`);
console.log(`  Pubkey B:         ${pkB.toString()}`);
console.log(`  Initial balance:  ${initialHbar} HBAR`);

const tx = await new AccountCreateTransaction()
  .setKey(thresholdKey)
  .setInitialBalance(new Hbar(initialHbar))
  .setMaxAutomaticTokenAssociations(-1)   // HIP-904: this account will hold HTS tokens
  .freezeWith(client);

const signed = await tx.sign(operatorKey);
const submit = await signed.execute(client);
const receipt = await submit.getReceipt(client);
const accountId = receipt.accountId;

// Fetch EVM alias from Mirror Node (the auto-derived alias for ThresholdKey accounts is "long-zero" by default — that's fine for contract calls).
const accountStr = accountId.toString();
const num = accountId.num.toString(16).padStart(40, "0");
const longZeroAlias = "0x" + num.padStart(40, "0");

console.log("\nDONE");
console.log(`  Account ID:      ${accountStr}`);
console.log(`  EVM alias:       ${longZeroAlias}`);
console.log(`  Tx ID:           ${submit.transactionId.toString()}`);
console.log("\nNext: add to deployments/295.json under `governance.threshold`:");
console.log(JSON.stringify({
  governance: { threshold: { id: accountStr, evm: longZeroAlias, signers: [pkA.toString(), pkB.toString()] } },
}, null, 2));

client.close();
