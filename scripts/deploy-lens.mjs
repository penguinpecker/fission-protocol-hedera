#!/usr/bin/env node
// Deploy FissionLens (read-only swap-preview contract) to Hedera mainnet.
// Single contract, no constructor args. Bytecode is 3.3KB raw / ~6.8KB hex,
// fits in ContractCreateFlow's single-file path.

import { Client, ContractCreateFlow, Hbar, PrivateKey } from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() { const p = join(REPO, ".env"); if (!existsSync(p)) return; for (const l of readFileSync(p,"utf8").split("\n")) { const t=l.trim(); if(!t||t.startsWith("#"))continue; const e=t.indexOf("="); if(e<0)continue; const k=t.slice(0,e).trim(); let v=t.slice(e+1).trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1); if(!process.env[k])process.env[k]=v; } }
loadDotenv();
function deriveKey() { if (process.env.HEDERA_OPERATOR_KEY) return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/,""); const s=process.env.SEED_PHRASE; if(!validateMnemonic(s,wordlist))throw new Error("bad seed"); const c=HDKey.fromMasterSeed(mnemonicToSeedSync(s)).derive(process.env.HEDERA_DERIVATION_PATH||"m/44'/3030'/0'/0/0"); return Buffer.from(c.privateKey).toString("hex"); }

const opKey = PrivateKey.fromStringECDSA(deriveKey());
const opId  = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(opId, opKey);
client.setDefaultMaxTransactionFee(new Hbar(20));

// Hedera FileService stores bytecode as HEX-ENCODED TEXT (not raw bytes).
const art = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionLens.sol/FissionLens.json"), "utf8"));
let hex = art.bytecode.object;
if (hex.startsWith("0x")) hex = hex.slice(2);
const bytecodeBytes = new TextEncoder().encode(hex);
console.log(`Bytecode: ${hex.length / 2} bytes raw, ${bytecodeBytes.length}b hex-text`);

console.log("\nDeploying FissionLens via ContractCreateFlow…");
const submit = await new ContractCreateFlow()
  .setBytecode(bytecodeBytes)
  .setGas(2_500_000)
  .setMaxAutomaticTokenAssociations(-1)
  .execute(client);
const receipt = await submit.getReceipt(client);
const contractId = receipt.contractId;
const num = contractId.num.toNumber();
const evm = "0x" + num.toString(16).padStart(40, "0");
console.log(`  ✓ Contract ID:  ${contractId.toString()}`);
console.log(`  ✓ EVM address:  ${evm}`);
console.log(`  ✓ Tx:           ${submit.transactionId.toString()}`);

// Persist into deployments JSON
const deploymentsPath = join(REPO, "deployments/295.json");
const dep = JSON.parse(readFileSync(deploymentsPath, "utf8"));
dep.lens = {
  contract_id: contractId.toString(),
  evm_address: evm,
  deployed_at: new Date().toISOString(),
  tx_id: submit.transactionId.toString(),
};
writeFileSync(deploymentsPath, JSON.stringify(dep, null, 2));
console.log(`\nSaved to deployments/295.json under .lens`);
client.close();
