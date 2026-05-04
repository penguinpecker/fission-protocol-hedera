#!/usr/bin/env node
// Calls factory.proposeSY(sy) for one or more SY addresses via Hedera SDK
// ContractExecuteTransaction. proposeSY starts the 7-day review window. After
// the window elapses, an admin must call confirmSY before the SY can back a
// market.
//
// Usage:
//   node scripts/propose-sy.mjs <factory-evm-address> <sy-evm-address> [<sy-evm-address> ...]

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

function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}

const args = process.argv.slice(2);
if (args.length < 2 || !args[0].startsWith("0x")) {
  console.error("Usage: node scripts/propose-sy.mjs <factory-evm-address> <sy-evm-address> [<sy-evm-address> ...]");
  process.exit(1);
}
const factoryEvm = args[0];
const syEvms = args.slice(1);

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

// Resolve factory EVM → Hedera contract id.
const lookup = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${factoryEvm}`);
const factoryId = ContractId.fromString((await lookup.json()).contract_id);
console.log(`Factory: ${factoryEvm}  →  ${factoryId.toString()}`);

for (const syEvm of syEvms) {
  console.log(`\n→ proposeSY(${syEvm})…`);
  const tx = new ContractExecuteTransaction()
    .setContractId(factoryId)
    .setGas(500_000)
    .setMaxTransactionFee(new Hbar(2))
    .setFunction("proposeSY", new ContractFunctionParameters().addAddress(syEvm));
  const submit = await tx.execute(client);
  const receipt = await submit.getReceipt(client);
  console.log(`  ${receipt.status.toString()}`);
  if (receipt.status.toString() !== "SUCCESS") {
    process.exit(1);
  }
}

const confirmAfter = new Date(Date.now() + 7 * 24 * 3600 * 1000);
console.log(`\n✓ All proposed. Confirm window opens at ${confirmAfter.toISOString()}`);
client.close();
