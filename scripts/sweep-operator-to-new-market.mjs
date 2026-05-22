#!/usr/bin/env node
// Sweep operator's residual SY + matching PT into the new market's LP.
// After the migration + AMM stress test, operator holds:
//   - ~1.04B raw SY shares (~$62 at HBAR=$0.09)
//   - ~7.62B raw PT (residual from migration)
// Pool is currently SY-heavy (ratio ~3.57:1 SY:PT). addLiquidityCore pulls
// proportionally and refunds the excess side, so we provide both and let it
// pick the binding side.

import { Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId, Hbar, PrivateKey } from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() {
  const p = join(REPO, ".env"); if (!existsSync(p)) return;
  for (const line of readFileSync(p,"utf8").split("\n")) {
    const t=line.trim(); if(!t||t.startsWith("#"))continue;
    const eq=t.indexOf("="); if(eq<0)continue;
    const k=t.slice(0,eq).trim(); let v=t.slice(eq+1).trim();
    if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);
    if(!process.env[k])process.env[k]=v;
  }
}
loadDotenv();
function deriveKeyHex(){
  if(process.env.HEDERA_OPERATOR_KEY)return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/,"");
  const seed=process.env.SEED_PHRASE;
  if(!validateMnemonic(seed,wordlist))throw new Error("bad SEED_PHRASE");
  const c=HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(process.env.HEDERA_DERIVATION_PATH||"m/44'/3030'/0'/0/0");
  return Buffer.from(c.privateKey).toString("hex");
}

const opKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const opEvm = ("0x" + opKey.publicKey.toEvmAddress()).toLowerCase();
const opId  = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(opId, opKey);
client.setDefaultMaxTransactionFee(new Hbar(20));

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const MARKET_EVM = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";
const MARKET_ID  = "0.0.10488661";
const PT_ID = "0.0.10488662";
const SY_ID = "0.0.10465419";

async function balance(tokenId, accountId) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`);
  const d = await r.json();
  const e = (d.tokens||[]).find(t=>t.token_id===tokenId);
  return e ? BigInt(e.balance) : 0n;
}
async function exec(contractId, fn, params, opts={}) {
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractId))
    .setGas(opts.gas ?? 3_500_000)
    .setMaxTransactionFee(new Hbar(opts.maxFee ?? 30))
    .setFunction(fn, params);
  const sub = await tx.execute(client);
  const rec = await sub.getReceipt(client);
  console.log(`  ${fn} → ${rec.status.toString()}  tx=${sub.transactionId.toString()}`);
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const opSy = await balance(SY_ID, opId);
const opPt = await balance(PT_ID, opId);
console.log(`Operator residuals: SY=${opSy} PT=${opPt}`);
if (opSy === 0n) {
  console.log("Nothing to sweep — operator has 0 SY.");
  process.exit(0);
}

// approve both
console.log("\nApprove SY + PT to market");
await exec(SY_ID, "approve",
  new ContractFunctionParameters().addAddress(MARKET_EVM.slice(2)).addUint256(opSy.toString()),
  { gas: 800_000, maxFee: 5 });
await sleep(4000);
await exec(PT_ID, "approve",
  new ContractFunctionParameters().addAddress(MARKET_EVM.slice(2)).addUint256(opPt.toString()),
  { gas: 800_000, maxFee: 5 });
await sleep(4000);

// addLiquidity — let the AMM pick the binding side
console.log(`\naddLiquidity(syIn=${opSy} ptIn=${opPt}) — refunds excess side`);
await exec(MARKET_ID, "addLiquidity",
  new ContractFunctionParameters()
    .addUint256(opSy.toString())
    .addUint256(opPt.toString())
    .addUint256("0")
    .addAddress(opEvm.slice(2)),
  { gas: 6_000_000 });
await sleep(6000);

const opSyAfter = await balance(SY_ID, opId);
const opPtAfter = await balance(PT_ID, opId);
console.log(`\nOperator after: SY=${opSyAfter} PT=${opPtAfter}`);
console.log(`Consumed: SY=${opSy - opSyAfter} (${opSy === opSyAfter ? "NONE" : "all SY"})  PT=${opPt - opPtAfter}`);
client.close();
