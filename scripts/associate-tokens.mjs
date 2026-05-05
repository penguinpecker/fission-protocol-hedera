#!/usr/bin/env node
// Explicitly associate HTS tokens to operator. Use when HIP-904
// auto-associations don't kick in (e.g. SaucerSwap's WHBAR contract uses
// a transfer pattern that doesn't trigger auto-associate).
//
// Usage:
//   node scripts/associate-tokens.mjs <token-id-1> <token-id-2> ...
//   token-id format: "0.0.NNNN" or "0xHEX" (will be resolved)

import {
  Client, AccountId, PrivateKey,
  TokenAssociateTransaction, TokenId, Hbar,
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

function deriveKey() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive("m/44'/3030'/0'/0/0");
  return Buffer.from(child.privateKey).toString("hex");
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/associate-tokens.mjs <token-id-1> ...");
  process.exit(1);
}

async function resolveTokenId(s) {
  if (s.startsWith("0.0.")) return s;
  if (s.startsWith("0x")) {
    const num = parseInt(s.slice(2), 16);
    return `0.0.${num}`;
  }
  throw new Error(`unknown token format: ${s}`);
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKey());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

const tokenIds = await Promise.all(args.map(resolveTokenId));
console.log(`Associating ${tokenIds.length} tokens to ${operatorIdStr}: ${tokenIds.join(", ")}`);

const tx = await new TokenAssociateTransaction()
  .setAccountId(AccountId.fromString(operatorIdStr))
  .setTokenIds(tokenIds.map(t => TokenId.fromString(t)))
  .setMaxTransactionFee(new Hbar(2))
  .freezeWith(client)
  .sign(operatorKey);
const r = await (await tx.execute(client)).getReceipt(client);
console.log(`  ${r.status.toString()}`);
client.close();
