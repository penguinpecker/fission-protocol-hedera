#!/usr/bin/env node
// Fund a contract with HBAR via TransferTransaction (NOT a contract call —
// avoids any payable() requirement on the contract).
//
// Usage: node scripts/fund-contract.mjs <evm-address> <hbar-amount>

import {
  Client, AccountId, ContractId, Hbar, PrivateKey,
  TransferTransaction,
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

const [evm, hbarStr] = process.argv.slice(2);
if (!evm?.startsWith("0x") || !hbarStr) {
  console.error("Usage: node scripts/fund-contract.mjs <evm-address> <hbar>");
  process.exit(1);
}
const hbar = Number(hbarStr);

const operatorKey = PrivateKey.fromStringECDSA(deriveKey());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

const r2 = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${evm}`);
const contractIdStr = (await r2.json()).contract_id;
console.log(`Funding ${evm} (${contractIdStr}) with ${hbar} HBAR…`);

const tx = new TransferTransaction()
  .addHbarTransfer(AccountId.fromString(operatorIdStr), new Hbar(-hbar))
  .addHbarTransfer(AccountId.fromString(contractIdStr), new Hbar(hbar))
  .setMaxTransactionFee(new Hbar(2));
const r = await (await tx.execute(client)).getReceipt(client);
console.log(`  ${r.status.toString()}`);
client.close();
