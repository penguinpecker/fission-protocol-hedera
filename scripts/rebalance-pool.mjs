#!/usr/bin/env node
// Unstick the pool. Currently 98.21% PT — the Pendle V2 curve refuses
// buyPT/buyYT trades that don't drop the PT proportion below 96%.
//
// Strategy: operator zaps HBAR → SY (gets ~3.4B raw SY for 200 HBAR),
// then swapExactSyForPt with HUGE ptOut. Pulls 3B PT out of pool +
// puts ~190M SY in → pool resets to ~92% PT. Buys are unstuck.
//
// Operator ends with ~3B raw PT (~$0.18 worth at par) — small net loss,
// big UX win for users.

import {
  Client, ContractExecuteTransaction, ContractFunctionParameters,
  ContractId, Hbar, PrivateKey,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() { const p=join(REPO,".env"); if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const e=t.indexOf("=");if(e<0)continue;const k=t.slice(0,e).trim();let v=t.slice(e+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;} }
loadDotenv();
function deriveKey() { if(process.env.HEDERA_OPERATOR_KEY)return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/,'');const s=process.env.SEED_PHRASE;if(!validateMnemonic(s,wordlist))throw new Error('bad seed');const c=HDKey.fromMasterSeed(mnemonicToSeedSync(s)).derive(process.env.HEDERA_DERIVATION_PATH||"m/44'/3030'/0'/0/0");return Buffer.from(c.privateKey).toString('hex'); }

const opKey = PrivateKey.fromStringECDSA(deriveKey());
const opId  = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const opEvm = "0x" + opKey.publicKey.toEvmAddress();
const client = Client.forMainnet().setOperator(opId, opKey);
const cid = (e) => ContractId.fromEvmAddress(0, 0, e);
const MAX_INT64 = (1n << 63n) - 1n;

const dep = JSON.parse(readFileSync(join(REPO,"deployments/295.json"),"utf8"));
const GATEWAY = dep.fission_gateway.evm;
const ROUTER  = dep.router_v3.evm;
const MARKET  = dep.markets[0].evm;
const SY_ADAPTER = dep.sy_saucer_v2_lp.evm;
const SY_SHARE = "0x00000000000000000000000000000000009fb08b";

console.log("\n=== POOL REBALANCE ===\n");

// Step 1: SKIP. Operator already has 326M SY from earlier zap.

// Step 2: SKIP. Already approved on previous run.

// Step 3: Router.swapExactSyForPt with HUGE ptOut to force rebalance.
// Pool currently 6.57B PT / 0.12B SY. Use whatever SY balance operator
// has + ask for 2B PT to materially drop the proportion.
console.log(`\nStep 3: swapExactSyForPt — pull 2B PT out, push 320M SY in...`);
const swap = await new ContractExecuteTransaction()
  .setContractId(cid(ROUTER))
  .setGas(8_000_000)
  .setFunction("swapExactSyForPt",
    new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256("320000000")           // syIn cap: 320M (operator has ~326M)
      .addUint256("2000000000")          // ptOut: 2B raw PT desired
      .addAddress(opEvm)
      .addUint256(0))
  .execute(client);
try {
  const sr = await swap.getReceipt(client);
  console.log(`  ${sr.status.toString()}  ${swap.transactionId.toString()}`);
  console.log(`  https://hashscan.io/mainnet/transaction/${swap.transactionId.toString()}`);
} catch (e) {
  console.log(`  FAILED: ${e.message?.slice(0,200)}`);
}

// Step 4: re-fetch pool state
await new Promise((r) => setTimeout(r, 5000));
const live = await fetch("https://www.fissionp.com/api/markets?chain_id=295").then((r)=>r.json());
const m = live.markets[0];
const pt = Number(m.total_pt), sy = Number(m.total_sy_shares);
console.log(`\n=== POST-REBALANCE POOL ===`);
console.log(`  total_pt    : ${pt.toLocaleString()}`);
console.log(`  total_sy    : ${sy.toLocaleString()}`);
console.log(`  proportion  : ${(100*pt/(pt+sy)).toFixed(2)}% PT`);

client.close();
