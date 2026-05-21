#!/usr/bin/env node
// Seeds the Ed25519-fixed new rewards market via:
//   1. Zap HBAR → SY shares (FissionZap)
//   2. Approve SY-share to new market
//   3. Split half → PT + YT
//   4. seedBurnYt the YT residual
//   5. Approve PT to new market
//   6. initialize(syIn, ptIn, anchor, lnFee, reservePct)

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

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(20));

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";

// ── targets ────────────────────────────────────────────────────────────────
const ZAP_ID         = "0.0.10475908";  // FissionZap (HBAR→SY)
const SY_EVM         = "0x00000000000000000000000000000000009fb089";
const SY_SHARE_ID    = "0.0.10465419";
const MARKET_ID      = "0.0.10488661";  // new fixed rewards market
const PT_ID          = "0.0.10488662";
const YT_ID          = "0.0.10488663";

// Zap config
const HBAR_TO_ZAP = Number(process.env.HBAR_TO_ZAP ?? "30");
// initialize() args
const INITIAL_ANCHOR  = process.env.INITIAL_ANCHOR_E18  ?? "1020000000000000000"; // 1.02e18
const LN_FEE_ROOT     = process.env.LN_FEE_RATE_ROOT_E18 ?? "300000000000000";    // 3e14
const RESERVE_PCT     = process.env.RESERVE_FEE_PERCENT ?? "80";

console.log("=".repeat(70));
console.log("Operator   :", operatorIdStr);
console.log("Zap        :", ZAP_ID);
console.log("Market     :", MARKET_ID, "(0x36ed8f34c9bfc0004f107153b1a16099f8910b58)");
console.log("SY share   :", SY_SHARE_ID);
console.log("HBAR_TO_ZAP:", HBAR_TO_ZAP);
console.log("=".repeat(70));

async function balance(tokenId, accountId) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`);
  const d = await r.json();
  const e = (d.tokens||[]).find(t=>t.token_id===tokenId);
  return e ? BigInt(e.balance) : 0n;
}
async function sleep(ms){await new Promise(r=>setTimeout(r,ms));}

async function exec(contractId, fn, params, opts = {}) {
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractId))
    .setGas(opts.gas ?? 3_500_000)
    .setMaxTransactionFee(new Hbar(opts.maxFee ?? 30))
    .setFunction(fn, params);
  if (opts.payableHbar) tx.setPayableAmount(new Hbar(opts.payableHbar));
  const sub = await tx.execute(client);
  const rec = await sub.getReceipt(client);
  console.log(`  ${fn} → ${rec.status.toString()}  tx=${sub.transactionId.toString()}`);
  return sub.transactionId.toString();
}

// ── Step 1: Zap HBAR → SY ────────────────────────────────────────────────
const syBefore = await balance(SY_SHARE_ID, operatorIdStr);
console.log(`\nStep 1: zapHbarToSy(${HBAR_TO_ZAP} HBAR)`);
await exec(ZAP_ID, "zapHbarToSy",
  new ContractFunctionParameters()
    .addAddress(SY_EVM.slice(2))
    .addUint256("0")    // usdcMinOut
    .addUint256("0")    // amount0Min
    .addUint256("0")    // amount1Min
    .addUint128("1")    // minShares
    .addAddress(operatorIdStr === "0.0.10463169" ? "32e8fd8434badbcc5d79e70e1fe0d16f86a7ab90" : ""),
  { gas: 14_500_000, payableHbar: HBAR_TO_ZAP + 5, maxFee: 80 }
);
await sleep(6000);
const syAfter = await balance(SY_SHARE_ID, operatorIdStr);
const syAcquired = syAfter - syBefore;
console.log(`  → acquired ${syAcquired.toLocaleString()} raw SY (before ${syBefore}, after ${syAfter})`);
if (syAcquired === 0n) {
  console.error("Zap produced 0 SY — abort");
  process.exit(1);
}

// ── Step 2: Approve SY-share to new market ───────────────────────────────
console.log(`\nStep 2: approve ${syAcquired.toString()} SY-share to market`);
await exec(SY_SHARE_ID, "approve",
  new ContractFunctionParameters()
    .addAddress("36ed8f34c9bfc0004f107153b1a16099f8910b58")
    .addUint256(syAcquired.toString()),
  { gas: 800_000 }
);
await sleep(4000);

// ── Step 3: Split half SY → PT + YT ──────────────────────────────────────
const splitAmount = syAcquired / 2n;
console.log(`\nStep 3: market.split(${splitAmount}) — mint PT+YT, keep half SY for LP side`);
await exec(MARKET_ID, "split",
  new ContractFunctionParameters().addUint256(splitAmount.toString()),
  { gas: 4_000_000 }
);
await sleep(6000);

const ptBal = await balance(PT_ID, operatorIdStr);
const ytBal = await balance(YT_ID, operatorIdStr);
console.log(`  Operator PT=${ptBal} YT=${ytBal}`);

// ── Step 4: seedBurnYt (dispose of YT — admin only) ──────────────────────
console.log(`\nStep 4: seedBurnYt(${ytBal}) — wipe YT (admin-gated)`);
if (ytBal > 0n) {
  await exec(MARKET_ID, "seedBurnYt",
    new ContractFunctionParameters().addUint256(ytBal.toString()),
    { gas: 1_500_000 }
  );
  await sleep(4000);
}

// ── Step 5: Approve PT to market ─────────────────────────────────────────
const ptAfter = await balance(PT_ID, operatorIdStr);
console.log(`\nStep 5: approve ${ptAfter} PT to market`);
await exec(PT_ID, "approve",
  new ContractFunctionParameters()
    .addAddress("36ed8f34c9bfc0004f107153b1a16099f8910b58")
    .addUint256(ptAfter.toString()),
  { gas: 800_000 }
);
await sleep(4000);

// Read current SY-share balance for the initialize call
const syNow = await balance(SY_SHARE_ID, operatorIdStr);
const syIn = syNow > splitAmount ? splitAmount : syNow;
const ptIn = ptAfter;
const initBoth = syIn < ptIn ? syIn : ptIn; // use the smaller side to keep 1:1 seed
console.log(`\nStep 6: initialize(syIn=${initBoth}, ptIn=${initBoth}, anchor=${INITIAL_ANCHOR})`);
await exec(MARKET_ID, "initialize",
  new ContractFunctionParameters()
    .addUint256(initBoth.toString())
    .addUint256(initBoth.toString())
    .addInt256(INITIAL_ANCHOR)
    .addInt256(LN_FEE_ROOT)
    .addUint256(RESERVE_PCT),
  { gas: 5_000_000 }
);
await sleep(6000);

const syFinal = await balance(SY_SHARE_ID, operatorIdStr);
const ptFinal = await balance(PT_ID, operatorIdStr);
console.log(`\nDone. Operator now holds:`);
console.log(`  SY-share: ${syFinal.toLocaleString()} raw`);
console.log(`  PT:       ${ptFinal.toLocaleString()} raw`);
console.log(`\nNew market 0.0.10488661 / 0x36ed8f34c9bfc0004f107153b1a16099f8910b58 initialized.`);

client.close();
