#!/usr/bin/env node
// Update ActionRouter's max_automatic_token_associations to -1 (HIP-904).
// The router was deployed with the default 0 — meaning any transferFrom
// of an HTS token into it (e.g. SY shares before a swap) fails silently
// at the HTS layer. With -1 the router auto-associates with any HTS token
// that hits it.
//
// Requires the operator key to be the router's admin key.

import {
  Client,
  ContractId,
  ContractUpdateTransaction,
  Hbar,
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
  const p = join(REPO, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
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

function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr) {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

const deploy = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
const ROUTER_ID = ContractId.fromString(deploy.router.id !== "(reused)" ? deploy.router.id : "0.0.10464662");

console.log(`Updating ${ROUTER_ID.toString()} maxAutoAssoc → -1…`);

const tx = await new ContractUpdateTransaction()
  .setContractId(ROUTER_ID)
  .setMaxAutomaticTokenAssociations(-1)
  .setMaxTransactionFee(new Hbar(5))
  .freezeWith(client)
  .sign(operatorKey);

const submit = await tx.execute(client);
const r = await submit.getReceipt(client);
console.log(`  Status: ${r.status.toString()}`);
console.log(`  Tx:     ${submit.transactionId.toString()}`);

client.close();
