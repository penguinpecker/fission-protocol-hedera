#!/usr/bin/env node
// Call `sy.initShareToken()` on a deployed SY contract via Hedera SDK
// ContractExecuteTransaction (NOT Hashio). The SDK lets us set
// `setPayableAmount` which Hedera consensus interprets correctly for the child
// TOKENCREATION fee allocation, where Hashio's Ethereum-tx relay doesn't.
//
// Usage:
//   node scripts/init-sy.mjs <sy-evm-address> [hbar-fee=2]

import {
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
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

const syArg = process.argv[2];
const fee = Number(process.argv[3] ?? "2");
if (!syArg || !syArg.startsWith("0x")) {
  console.error("Usage: node scripts/init-sy.mjs <sy-evm-address> [hbar-fee=2]");
  process.exit(1);
}

function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!seed) throw new Error("Set SEED_PHRASE or HEDERA_OPERATOR_KEY");
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  if (!child.privateKey) throw new Error(`derivation at ${path} failed`);
  return Buffer.from(child.privateKey).toString("hex");
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();

let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const res = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  const data = await res.json();
  operatorIdStr = data.account;
}

const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(20));

// Convert 0x... to 0.0.X via Mirror Node lookup.
const hex = syArg.toLowerCase().replace(/^0x/, "");
const num = parseInt(hex, 16);
if (Number.isNaN(num)) throw new Error("invalid sy address");
const contractId = ContractId.fromEvmAddress(0, 0, syArg);

console.log(`\n→ Calling initShareToken on ${syArg} (contract ${contractId.toString()}) with ${fee} HBAR…`);

// Hedera spawns a child TOKENCREATION HAPI tx for createFungibleToken; its
// fee budget is allocated from the parent ContractExecute's max_fee, NOT from
// msg.value. Set max_fee to 30 HBAR so the child has plenty.
const tx = new ContractExecuteTransaction()
  .setContractId(contractId)
  .setGas(15_000_000)
  .setMaxTransactionFee(new Hbar(30))
  .setPayableAmount(new Hbar(fee))
  .setFunction("initShareToken");

const submit = await tx.execute(client);
const receipt = await submit.getReceipt(client);
console.log(`  receipt: ${receipt.status.toString()}`);

if (receipt.status.toString() === "SUCCESS") {
  console.log(`  ✓ initShareToken succeeded`);
} else {
  console.log(`  ✗ ${receipt.status.toString()}`);
  process.exit(1);
}
client.close();
