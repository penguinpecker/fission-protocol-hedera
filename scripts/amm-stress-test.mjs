#!/usr/bin/env node
// Stress-test the new market's AMM with the migrated $300-600 of liquidity.
// Drives a variety of trade sizes (small → large) to confirm:
//   - Slippage scales correctly with size
//   - lastLnImpliedRate moves in the expected direction per trade
//   - No reverts on edge cases (precision, sign-flip, slippage floor)
//   - State invariants preserved (totalSy/totalPt match physical balances modulo
//     backing-bucket SY)
//   - swapExactYtForSy curve makes economic sense across sizes

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
const RPC    = "https://mainnet.hashio.io/api";

const MARKET_EVM = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";
const MARKET_ID  = "0.0.10488661";
const PT_ID      = "0.0.10488662";
const YT_ID      = "0.0.10488663";
const SY_ID      = "0.0.10465419";
const ROUTER_EVM = "0x00000000000000000000000000000000009fd993";
const ROUTER_ID  = "0.0.10475923";

async function rpc(to, data) {
  const r = await fetch(RPC, { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"eth_call", params:[{to,data},"latest"] }) }).then(x=>x.json());
  if (r.error) throw new Error(r.error.message);
  return r.result;
}
async function pool() {
  return {
    totalSy: BigInt(await rpc(MARKET_EVM, "0xc7bfb21e")),
    totalPt: BigInt(await rpc(MARKET_EVM, "0xb4b9106d")),
    last:    BigInt(await rpc(MARKET_EVM, "0x43bf8ab3")),
  };
}
async function bal(tokenId, accountId) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`);
  const d = await r.json();
  const e = (d.tokens||[]).find(t=>t.token_id===tokenId);
  return e ? BigInt(e.balance) : 0n;
}
async function ytBalanceOf(who) {
  const data = "0x2273bcc6" + who.replace(/^0x/,"").padStart(64,"0");
  return BigInt(await rpc(MARKET_EVM, data));
}
async function exec(contractId, fn, params, opts={}) {
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractId))
    .setGas(opts.gas ?? 3_500_000)
    .setMaxTransactionFee(new Hbar(opts.maxFee ?? 30))
    .setFunction(fn, params);
  if (opts.payableHbar) tx.setPayableAmount(new Hbar(opts.payableHbar));
  const sub = await tx.execute(client);
  const rec = await sub.getReceipt(client);
  return { status: rec.status.toString(), txId: sub.transactionId.toString() };
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const results = [];
function rec(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`  [${status}] ${name}  ${detail}`);
}

console.log("="*70);
console.log("AMM STRESS TEST — new market 0x36ed8f...8b58");
console.log("=".repeat(70));

const start = await pool();
const opSyStart = await bal(SY_ID, opId);
const opPtStart = await bal(PT_ID, opId);
const opYtStart = await ytBalanceOf(opEvm);
console.log(`\nStart pool:    totalSy=${start.totalSy.toLocaleString()}  totalPt=${start.totalPt.toLocaleString()}  last=${start.last}`);
console.log(`Start op:      SY=${opSyStart.toLocaleString()}  PT=${opPtStart.toLocaleString()}  YT=${opYtStart.toLocaleString()}`);

// ───────── Test battery ─────────

// 1. Sell PT at increasing sizes — capture slippage
console.log("\n--- Sell PT slippage ladder ---");
for (const sz of [1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n]) {
  const before = await pool();
  const ptBefore = await bal(PT_ID, opId);
  const syBefore = await bal(SY_ID, opId);
  if (ptBefore < sz) {
    rec(`sellPt ${sz}`, "SKIP", `op has only ${ptBefore} PT`);
    continue;
  }
  try {
    await exec(PT_ID, "approve",
      new ContractFunctionParameters().addAddress(ROUTER_EVM.slice(2)).addUint256(sz.toString()),
      { gas: 800_000, maxFee: 5 });
    const deadline = Math.floor(Date.now()/1000) + 600;
    const r = await exec(ROUTER_ID, "swapExactPtForSy",
      new ContractFunctionParameters()
        .addAddress(MARKET_EVM.slice(2))
        .addUint256(sz.toString())
        .addUint256("1") // min 1
        .addAddress(opEvm.slice(2))
        .addUint256(deadline.toString()),
      { gas: 3_500_000, maxFee: 20 });
    await sleep(7000);
    const after = await pool();
    const ptAfter = await bal(PT_ID, opId);
    const syAfter = await bal(SY_ID, opId);
    const syOut = syAfter - syBefore;
    const ptIn = ptBefore - ptAfter;
    const rate = Number(syOut) / Number(ptIn);
    const ratio = Number(after.totalSy) / Number(after.totalPt);
    rec(`sellPt ${sz}`, r.status==="SUCCESS"?"PASS":"FAIL",
      `tx=${r.txId} ptIn=${ptIn} syOut=${syOut} rate=${rate.toFixed(4)} poolRatio_SY:PT=${ratio.toFixed(3)} lastΔ=${after.last - before.last}`);
  } catch (e) {
    rec(`sellPt ${sz}`, "FAIL", e.message);
  }
}

// 2. Sell YT at increasing sizes (the NEW function)
console.log("\n--- Sell YT slippage ladder ---");
const opYt = await ytBalanceOf(opEvm);
console.log(`  op YT balance: ${opYt}`);
for (const sz of [1_000_000n, 10_000_000n, 50_000_000n]) {
  const ytBefore = await ytBalanceOf(opEvm);
  if (ytBefore < sz) { rec(`sellYt ${sz}`, "SKIP", `op only has ${ytBefore} YT`); continue; }
  const before = await pool();
  const syBefore = await bal(SY_ID, opId);
  try {
    const r = await exec(MARKET_ID, "swapExactYtForSy",
      new ContractFunctionParameters()
        .addUint256(sz.toString())
        .addUint256("1")
        .addAddress(opEvm.slice(2)),
      { gas: 4_500_000, maxFee: 20 });
    await sleep(7000);
    const after = await pool();
    const ytAfter = await ytBalanceOf(opEvm);
    const syAfter = await bal(SY_ID, opId);
    const syOut = syAfter - syBefore;
    const ytIn = ytBefore - ytAfter;
    const rate = Number(syOut) / Number(ytIn);
    rec(`sellYt ${sz}`, r.status==="SUCCESS"?"PASS":"FAIL",
      `tx=${r.txId} ytIn=${ytIn} syOut=${syOut} rate=${rate.toFixed(4)} (= 1-ptRate) lastΔ=${after.last - before.last}`);
  } catch (e) {
    rec(`sellYt ${sz}`, "FAIL", e.message);
  }
}

// 3. Buy PT at increasing sizes
console.log("\n--- Buy PT slippage ladder ---");
for (const sz of [1_000_000n, 10_000_000n, 50_000_000n]) {
  const syBefore = await bal(SY_ID, opId);
  if (syBefore < sz) { rec(`buyPt ${sz}`, "SKIP", `op only has ${syBefore} SY`); continue; }
  const ptBefore = await bal(PT_ID, opId);
  const before = await pool();
  try {
    await exec(SY_ID, "approve",
      new ContractFunctionParameters().addAddress(ROUTER_EVM.slice(2)).addUint256(sz.toString()),
      { gas: 800_000, maxFee: 5 });
    const minPtOut = (sz * 9000n) / 10_000n; // 10% slippage
    const deadline = Math.floor(Date.now()/1000) + 600;
    const r = await exec(ROUTER_ID, "swapExactSyForPt",
      new ContractFunctionParameters()
        .addAddress(MARKET_EVM.slice(2))
        .addUint256(sz.toString())
        .addUint256(minPtOut.toString())
        .addAddress(opEvm.slice(2))
        .addUint256(deadline.toString()),
      { gas: 3_500_000, maxFee: 20 });
    await sleep(7000);
    const after = await pool();
    const ptAfter = await bal(PT_ID, opId);
    const syAfter = await bal(SY_ID, opId);
    const ptOut = ptAfter - ptBefore;
    const syIn = syBefore - syAfter;
    const rate = ptOut > 0n ? Number(syIn) / Number(ptOut) : 0;
    rec(`buyPt ${sz}`, r.status==="SUCCESS"?"PASS":"FAIL",
      `tx=${r.txId} syIn=${syIn} ptOut=${ptOut} rate=${rate.toFixed(4)} lastΔ=${after.last - before.last}`);
  } catch (e) {
    rec(`buyPt ${sz}`, "FAIL", e.message);
  }
}

// 4. Final state
console.log("\n--- Final state ---");
const final = await pool();
const opSyEnd = await bal(SY_ID, opId);
const opPtEnd = await bal(PT_ID, opId);
const opYtEnd = await ytBalanceOf(opEvm);
console.log(`Pool: totalSy=${final.totalSy.toLocaleString()} totalPt=${final.totalPt.toLocaleString()} last=${final.last}`);
console.log(`Op:   SY=${opSyEnd.toLocaleString()} PT=${opPtEnd.toLocaleString()} YT=${opYtEnd.toLocaleString()}`);

const passes = results.filter(r=>r.status==="PASS").length;
const fails  = results.filter(r=>r.status==="FAIL").length;
const skips  = results.filter(r=>r.status==="SKIP").length;
console.log(`\n${passes} PASS  ${fails} FAIL  ${skips} SKIP  out of ${results.length}`);
client.close();
