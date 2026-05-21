#!/usr/bin/env node
// Phase 3 of the migration (replaces init-new since new market is already initialized).
// After drain: operator holds ~21B raw SY shares + 0 PT/YT/LP. This script:
//   1. Reads operator's SY-share balance + new market's (totalSy, totalPt) state
//   2. Splits half SY → PT + YT on new market
//   3. seedBurnYt the residual YT (admin function)
//   4. addLiquidity(syIn, ptIn, …) — adds proportional LP to the existing pool
//
// Resulting state: new market's TVL ≈ matches the value previously locked in old market.

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

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const operatorEvm = ("0x" + operatorKey.publicKey.toEvmAddress()).toLowerCase();
const operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(20));

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const RPC = "https://mainnet.hashio.io/api";

// Targets
const NEW_MARKET_EVM   = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";
const NEW_MARKET_ID    = "0.0.10488661";
const NEW_PT_ID        = "0.0.10488662";
const NEW_YT_ID        = "0.0.10488663";
const SY_SHARE_ID      = "0.0.10465419";

async function balance(tokenId, accountId) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`);
  const d = await r.json();
  const e = (d.tokens||[]).find(t=>t.token_id===tokenId);
  return e ? BigInt(e.balance) : 0n;
}
async function rpc(to, data) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"eth_call", params:[{to,data},"latest"] }),
  }).then(x=>x.json());
  if (r.error) throw new Error(r.error.message);
  return r.result;
}
async function readPool() {
  const totalSy = BigInt(await rpc(NEW_MARKET_EVM, "0xc7bfb21e"));
  const totalPt = BigInt(await rpc(NEW_MARKET_EVM, "0xb4b9106d"));
  return { totalSy, totalPt };
}
async function exec(contractId, fn, params, opts={}) {
  if (DRY_RUN) {
    console.log(`  [DRY] ${fn} on ${contractId} gas=${opts.gas||3_500_000}`);
    return;
  }
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractId))
    .setGas(opts.gas ?? 3_500_000)
    .setMaxTransactionFee(new Hbar(opts.maxFee ?? 30))
    .setFunction(fn, params);
  if (opts.payableHbar) tx.setPayableAmount(new Hbar(opts.payableHbar));
  const sub = await tx.execute(client);
  const rec = await sub.getReceipt(client);
  console.log(`  ${fn} → ${rec.status.toString()}  tx=${sub.transactionId.toString()}`);
}
async function sleep(ms){await new Promise(r=>setTimeout(r,ms));}

console.log("=".repeat(70));
console.log(`Operator:   ${operatorIdStr}  ${operatorEvm}`);
console.log(`New market: ${NEW_MARKET_ID}  ${NEW_MARKET_EVM}`);
console.log(`Mode:       ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
console.log("=".repeat(70));

const sy0 = await balance(SY_SHARE_ID, operatorIdStr);
console.log(`\nOperator SY-share balance: ${sy0.toLocaleString()} raw`);
if (sy0 < 1_000_000n) {
  console.error("Operator SY too low — did drain complete? Aborting.");
  process.exit(1);
}

const pool0 = await readPool();
console.log(`New market pool: totalSy=${pool0.totalSy.toLocaleString()} totalPt=${pool0.totalPt.toLocaleString()}`);

// Plan: split half of operator's SY into PT+YT to match the pool's PT inventory growth.
// Pool is ~1:1 right now, so 50/50 split keeps the ratio. addLiquidityCore handles
// any minor proportional drift by pulling only `syUsed` and `ptUsed` (≤ inputs).
const splitAmount = sy0 / 2n;
console.log(`\nWill split ${splitAmount.toLocaleString()} SY → ${splitAmount.toLocaleString()} PT + ${splitAmount.toLocaleString()} YT`);

// ── Step 1: approve SY → market for the split ──
console.log(`\nStep 1: approve ${sy0.toLocaleString()} SY-share to market`);
await exec(SY_SHARE_ID, "approve",
  new ContractFunctionParameters()
    .addAddress(NEW_MARKET_EVM.slice(2))
    .addUint256(sy0.toString()),
  { gas: 800_000 }
);
if (!DRY_RUN) await sleep(4000);

// ── Step 2: split ──
console.log(`\nStep 2: market.split(${splitAmount.toLocaleString()})`);
await exec(NEW_MARKET_ID, "split",
  new ContractFunctionParameters().addUint256(splitAmount.toString()),
  { gas: 5_000_000 }
);
if (!DRY_RUN) await sleep(6000);

// ── Step 3: seedBurnYt to dispose of residual YT ──
const ytBal = await balance(NEW_YT_ID, operatorIdStr);
console.log(`\nOperator YT after split: ${ytBal.toLocaleString()}`);
console.log(`Step 3: seedBurnYt(${ytBal.toLocaleString()}) — admin wipe`);
await exec(NEW_MARKET_ID, "seedBurnYt",
  new ContractFunctionParameters().addUint256(ytBal.toString()),
  { gas: 2_000_000 }
);
if (!DRY_RUN) await sleep(6000);

// ── Step 4: approve PT to market ──
const ptBal = await balance(NEW_PT_ID, operatorIdStr);
const syNow = await balance(SY_SHARE_ID, operatorIdStr);
console.log(`\nOperator PT=${ptBal.toLocaleString()}  SY=${syNow.toLocaleString()} (post-split)`);
console.log(`Step 4: approve ${ptBal.toLocaleString()} PT to market`);
await exec(NEW_PT_ID, "approve",
  new ContractFunctionParameters()
    .addAddress(NEW_MARKET_EVM.slice(2))
    .addUint256(ptBal.toString()),
  { gas: 800_000 }
);
if (!DRY_RUN) await sleep(4000);

// ── Step 5: addLiquidity proportional ──
// Use the full PT and matching SY. addLiquidityCore picks the binding side and
// only pulls min(syIn, ptIn × ratio).
const syIn = syNow;
const ptIn = ptBal;
console.log(`\nStep 5: addLiquidity(syIn=${syIn.toLocaleString()}, ptIn=${ptIn.toLocaleString()}, minLpOut=0, receiver=operator)`);
await exec(NEW_MARKET_ID, "addLiquidity",
  new ContractFunctionParameters()
    .addUint256(syIn.toString())
    .addUint256(ptIn.toString())
    .addUint256("0")
    .addAddress(operatorEvm.slice(2)),
  { gas: 6_000_000 }
);
if (!DRY_RUN) await sleep(6000);

const pool1 = await readPool();
const syFinal = await balance(SY_SHARE_ID, operatorIdStr);
const ptFinal = await balance(NEW_PT_ID, operatorIdStr);
console.log(`\n${"=".repeat(70)}`);
console.log(`POST-ADD STATE`);
console.log(`${"=".repeat(70)}`);
console.log(`New market pool:`);
console.log(`  totalSy: ${pool0.totalSy.toLocaleString()} → ${pool1.totalSy.toLocaleString()}  (Δ ${(pool1.totalSy - pool0.totalSy).toLocaleString()})`);
console.log(`  totalPt: ${pool0.totalPt.toLocaleString()} → ${pool1.totalPt.toLocaleString()}  (Δ ${(pool1.totalPt - pool0.totalPt).toLocaleString()})`);
console.log(`Operator residual:`);
console.log(`  SY-share: ${syFinal.toLocaleString()} raw`);
console.log(`  PT:       ${ptFinal.toLocaleString()} raw`);
console.log(`\nDone. New market now reflects the migrated liquidity.`);

client.close();
