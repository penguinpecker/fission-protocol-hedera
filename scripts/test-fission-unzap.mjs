#!/usr/bin/env node
// Mainnet smoke test for FissionUnzap.sellPtForHbar.
//
// Approve a tiny PT to the unzap, call sellPtForHbar, verify the operator
// gains HBAR. Tiny amount (1M raw PT ≈ $0.06) keeps gas + pool-impact
// minimal. Uses the operator key which already holds plenty of PT from
// earlier audit + LP work.

import { Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId, Hbar, PrivateKey } from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import BigNumber from "bignumber.js";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() { const p = join(REPO, ".env"); if (!existsSync(p)) return; for (const l of readFileSync(p,"utf8").split("\n")) { const t=l.trim(); if(!t||t.startsWith("#"))continue; const e=t.indexOf("="); if(e<0)continue; const k=t.slice(0,e).trim(); let v=t.slice(e+1).trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1); if(!process.env[k])process.env[k]=v; } }
loadDotenv();
function deriveKey() { if (process.env.HEDERA_OPERATOR_KEY) return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/,""); const s=process.env.SEED_PHRASE; if(!validateMnemonic(s,wordlist))throw new Error("bad seed"); const c=HDKey.fromMasterSeed(mnemonicToSeedSync(s)).derive(process.env.HEDERA_DERIVATION_PATH||"m/44'/3030'/0'/0/0"); return Buffer.from(c.privateKey).toString("hex"); }

const opKey = PrivateKey.fromStringECDSA(deriveKey());
const opEvm = ("0x" + opKey.publicKey.toEvmAddress()).toLowerCase();
const opId  = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(opId, opKey);

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const dep = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));

const UNZAP_ID = dep.fission_unzap.id;
const UNZAP_EVM = dep.fission_unzap.evm;
const MARKET = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";
const MARKET_ID = "0.0.10488661";
const PT_ID = "0.0.10488662";

const ptIn = 1_000_000n; // 1M raw PT
const minHbarOut = 1n; // accept anything > 0
const deadline = Math.floor(Date.now() / 1000) + 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hbarBalance(account) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${account}`).then((x) => x.json());
  return BigInt(r.balance?.balance ?? 0);
}

console.log("FissionUnzap smoke — PT → HBAR on mainnet");
console.log(`  unzap:     ${UNZAP_ID} (${UNZAP_EVM})`);
console.log(`  operator:  ${opId} (${opEvm})`);
console.log(`  PT in:     ${ptIn} raw`);
console.log("");

const hbarBefore = await hbarBalance(opId);
console.log(`  HBAR balance pre:  ${hbarBefore} tinybars`);

console.log("\nStep 1: approve PT to unzap…");
const a = await new ContractExecuteTransaction()
  .setContractId(ContractId.fromString(PT_ID))
  .setGas(800_000)
  .setFunction(
    "approve",
    new ContractFunctionParameters()
      .addAddress(UNZAP_EVM.slice(2))
      .addUint256(new BigNumber(ptIn.toString())),
  )
  .setMaxTransactionFee(new Hbar(20))
  .execute(client);
const aR = await a.getReceipt(client);
console.log(`  approve: ${aR.status.toString()}  tx=${a.transactionId.toString()}`);
await sleep(4000);

console.log("\nStep 2: sellPtForHbar…");
const s = await new ContractExecuteTransaction()
  .setContractId(ContractId.fromString(UNZAP_ID))
  .setGas(8_000_000)
  .setFunction(
    "sellPtForHbar",
    new ContractFunctionParameters()
      .addAddress(MARKET.slice(2))
      .addUint256(new BigNumber(ptIn.toString()))
      .addUint256(new BigNumber(minHbarOut.toString()))
      .addAddress(opEvm.slice(2))
      .addUint256(new BigNumber(deadline.toString())),
  )
  .setMaxTransactionFee(new Hbar(40))
  .execute(client);
const sR = await s.getReceipt(client);
console.log(`  sellPtForHbar: ${sR.status.toString()}  tx=${s.transactionId.toString()}`);
console.log(`  HashScan: https://hashscan.io/mainnet/transaction/${s.transactionId.toString()}`);
await sleep(6000);

const hbarAfter = await hbarBalance(opId);
const delta = hbarAfter - hbarBefore;
console.log(`\n  HBAR balance post: ${hbarAfter} tinybars`);
console.log(`  Delta:             ${delta} tinybars (net of gas)`);

if (sR.status.toString() === "SUCCESS") {
  console.log("\n✅ PASS — PT → HBAR end-to-end works on mainnet");
} else {
  console.log("\n❌ FAIL");
}

client.close();
process.exit(0);
