#!/usr/bin/env node
// Live forensic audit of the new SS-V2-90D-FIX rewards market.
// Market: 0x36ed8f34c9bfc0004f107153b1a16099f8910b58 (0.0.10488661)
//
// Tests (small amounts to keep slippage in check on a ~22M raw pool):
//   1. previewYield / previewRewards views
//   2. Buy PT via router.swapExactSyForPt
//   3. Sell PT via router.swapExactPtForSy
//   4. Buy YT via router.buyYT
//   5. Sell YT direct on market.swapExactYtForSy
//   6. Router slippage revert on swapExactPtForSy

import {
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  PrivateKey,
  AccountBalanceQuery,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() {
  const p = join(REPO, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
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

// ───────────── constants ─────────────
const MARKET = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";
const MARKET_ID = "0.0.10488661";
const PT = "0x0000000000000000000000000000000000a00b56";
const YT = "0x0000000000000000000000000000000000a00b57";
const LP = "0x0000000000000000000000000000000000a00b58";
const SY = "0x00000000000000000000000000000000009fb089";
const ROUTER = "0x00000000000000000000000000000000009fd993";
const ROUTER_ID = ContractId.fromString("0.0.10475923");
const ZAP = "0x00000000000000000000000000000000009fd984";
const ZAP_ID = ContractId.fromString("0.0.10475908");

const RPC = "https://mainnet.hashio.io/api";

// ───────────── helpers ─────────────
async function rpc(to, data, label = "") {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  }).then((x) => x.json());
  if (r.error) throw new Error(`rpc ${label} ${r.error.message}`);
  return r.result;
}

async function balanceOf(token, who) {
  const data = "0x70a08231" + who.replace(/^0x/, "").padStart(64, "0");
  try {
    const r = await rpc(token, data, `balanceOf(${token})`);
    return BigInt(r);
  } catch (e) {
    return null; // HTS facade can revert
  }
}

// Mirror node fallback for HTS token balances
async function mirrorTokenBalance(tokenId, accountId) {
  const r = await fetch(
    `https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`
  ).then((x) => x.json());
  const t = (r.tokens || []).find((t) => t.token_id === tokenId);
  return t ? BigInt(t.balance) : 0n;
}

const num = (h) => BigInt(h);
async function readMarket() {
  const totalSy = num(await rpc(MARKET, "0xc7bfb21e", "totalSy"));
  const totalPt = num(await rpc(MARKET, "0xb4b9106d", "totalPt"));
  const last = num(await rpc(MARKET, "0x43bf8ab3", "lastLnImpliedRate"));
  return { totalSy, totalPt, lastLnImpliedRate: last };
}
async function ytBalanceOf(who) {
  const data = "0x2273bcc6" + who.replace(/^0x/, "").padStart(64, "0");
  return BigInt(await rpc(MARKET, data, "ytBalanceOf"));
}

function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let opIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!opIdStr) {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  opIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(opIdStr, operatorKey);

// SY share token = resolve once
const shareTok = "0x" + (await rpc(SY, "0x6c9fa59e", "shareToken")).slice(26);

async function hbarBalance() {
  const q = await new AccountBalanceQuery().setAccountId(opIdStr).execute(client);
  return Number(q.hbars.toBigNumber());
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

console.log(`Operator:   ${evmAddr} / ${opIdStr}`);
console.log(`Market:     ${MARKET} (${MARKET_ID})`);
console.log(`Router:     ${ROUTER}`);
console.log(`Zap:        ${ZAP}`);
console.log(`SY share:   ${shareTok}`);
console.log(`PT / YT / LP: ${PT} / ${YT} / ${LP}`);

const startHbar = await hbarBalance();
console.log(`\nStart HBAR: ${startHbar}`);

const startMarket = await readMarket();
console.log(`Market: totalSy=${startMarket.totalSy} totalPt=${startMarket.totalPt} lastLnImpliedRate=${startMarket.lastLnImpliedRate}`);

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`\n[${status}] ${name} :: ${detail}`);
}

// ───────────── Test 1: preview views ─────────────
console.log(`\n========================================`);
console.log(`Test 1: previewYield / previewRewards`);
console.log(`========================================`);
try {
  const yieldData = "0xe8ae8aba" + evmAddr.replace(/^0x/, "").padStart(64, "0");
  let pyResult;
  try {
    pyResult = await rpc(MARKET, yieldData, "previewYield");
    record("1a previewYield", "PASS", `returned ${BigInt(pyResult)}`);
  } catch (e) {
    record("1a previewYield", "INFO", `reverted (expected on rewards-type market): ${e.message.slice(0, 80)}`);
  }
  const rewardsData = "0xf166e920" + evmAddr.replace(/^0x/, "").padStart(64, "0");
  const prResult = await rpc(MARKET, rewardsData, "previewRewards");
  const amount0 = BigInt("0x" + prResult.slice(2, 66));
  const amount1 = BigInt("0x" + prResult.slice(66, 130));
  record("1b previewRewards", "PASS", `amount0=${amount0} amount1=${amount1}`);
} catch (e) {
  record("1 preview views", "FAIL", e.message);
}

// ───────────── Pre-zap: SY share balance ─────────────
let syBal = (await balanceOf(shareTok, evmAddr)) ?? 0n;
console.log(`\nOp SY-share balance: ${syBal}`);

if (syBal < 1_000_000n) {
  console.log(`\nSY balance too small (${syBal}). Zapping 8 HBAR to get more SY shares…`);
  try {
    const HBAR_AMOUNT = 8;
    const NPM_HBAR = 5;
    const msgValueHbar = HBAR_AMOUNT + NPM_HBAR;
    const params = new ContractFunctionParameters()
      .addAddress(SY)
      .addUint256("0").addUint256("0").addUint256("0").addUint128("1")
      .addAddress(evmAddr);
    const tx = new ContractExecuteTransaction()
      .setContractId(ZAP_ID).setGas(14_500_000).setMaxTransactionFee(new Hbar(50))
      .setPayableAmount(new Hbar(msgValueHbar))
      .setFunction("zapHbarToSy", params);
    const sub = await tx.execute(client);
    const rec = await sub.getReceipt(client);
    console.log(`  zap status: ${rec.status.toString()}   tx: ${sub.transactionId.toString()}`);
    await sleep(8000);
    syBal = (await balanceOf(shareTok, evmAddr)) ?? 0n;
    console.log(`  Op SY-share after zap: ${syBal}`);
  } catch (e) {
    console.log(`  zap failed: ${e.message}`);
  }
}

// ───────────── Test 2: Buy PT ─────────────
console.log(`\n========================================`);
console.log(`Test 2: Buy PT via swapExactSyForPt`);
console.log(`========================================`);
const m2 = await readMarket();
console.log(`  pre: totalSy=${m2.totalSy} totalPt=${m2.totalPt} last=${m2.lastLnImpliedRate}`);
const SY_IN = 500_000n; // ~$0.03, ~2.2% of pool
const MIN_PT_OUT = (SY_IN * 9900n) / 10_000n; // 1% slippage
const ptBefore = (await balanceOf(PT, evmAddr)) ?? 0n;
console.log(`  spend ${SY_IN} SY → expect ≥${MIN_PT_OUT} PT (PT bal before: ${ptBefore})`);
try {
  // approve
  const approveTx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, shareTok))
    .setGas(800_000).setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(ROUTER).addUint256(SY_IN.toString()));
  await (await approveTx.execute(client)).getReceipt(client);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const swapTx = new ContractExecuteTransaction()
    .setContractId(ROUTER_ID).setGas(3_500_000).setMaxTransactionFee(new Hbar(20))
    .setFunction("swapExactSyForPt",
      new ContractFunctionParameters()
        .addAddress(MARKET).addUint256(SY_IN.toString()).addUint256(MIN_PT_OUT.toString())
        .addAddress(evmAddr).addUint256(deadline.toString()));
  const sub = await swapTx.execute(client);
  const rec = await sub.getReceipt(client);
  await sleep(6000);
  const ptAfter = (await balanceOf(PT, evmAddr)) ?? 0n;
  const m2b = await readMarket();
  const status = rec.status.toString();
  const ok = status === "SUCCESS" && ptAfter > ptBefore && m2b.totalSy > m2.totalSy && m2b.totalPt < m2.totalPt;
  record("2 swapExactSyForPt", ok ? "PASS" : "FAIL",
    `tx=${sub.transactionId.toString()} status=${status} PT Δ${ptAfter - ptBefore} totalSy Δ${m2b.totalSy - m2.totalSy} totalPt Δ${m2b.totalPt - m2.totalPt} last Δ${m2b.lastLnImpliedRate - m2.lastLnImpliedRate}`);
} catch (e) {
  record("2 swapExactSyForPt", "FAIL", e.message);
}

// ───────────── Test 3: Sell PT back ─────────────
console.log(`\n========================================`);
console.log(`Test 3: Sell PT via swapExactPtForSy`);
console.log(`========================================`);
const ptBal3 = (await balanceOf(PT, evmAddr)) ?? 0n;
const syBal3 = (await balanceOf(shareTok, evmAddr)) ?? 0n;
const m3 = await readMarket();
console.log(`  pre: PT bal=${ptBal3} SY bal=${syBal3} totalSy=${m3.totalSy} totalPt=${m3.totalPt}`);
const PT_IN = ptBal3 / 4n; // sell ~25% of acquired PT
const MIN_SY = (PT_IN * 9000n) / 10_000n; // 10% slippage tolerance (PT trades at discount)
try {
  const approveTx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, PT)).setGas(800_000).setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(ROUTER).addUint256(PT_IN.toString()));
  await (await approveTx.execute(client)).getReceipt(client);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const swapTx = new ContractExecuteTransaction()
    .setContractId(ROUTER_ID).setGas(3_500_000).setMaxTransactionFee(new Hbar(20))
    .setFunction("swapExactPtForSy",
      new ContractFunctionParameters()
        .addAddress(MARKET).addUint256(PT_IN.toString()).addUint256(MIN_SY.toString())
        .addAddress(evmAddr).addUint256(deadline.toString()));
  const sub = await swapTx.execute(client);
  const rec = await sub.getReceipt(client);
  await sleep(6000);
  const ptAfter = (await balanceOf(PT, evmAddr)) ?? 0n;
  const syAfter = (await balanceOf(shareTok, evmAddr)) ?? 0n;
  const m3b = await readMarket();
  const status = rec.status.toString();
  const ok = status === "SUCCESS" && syAfter > syBal3 && m3b.totalPt > m3.totalPt && m3b.totalSy < m3.totalSy;
  record("3 swapExactPtForSy", ok ? "PASS" : "FAIL",
    `tx=${sub.transactionId.toString()} status=${status} PT Δ${ptAfter - ptBal3} SY Δ${syAfter - syBal3} totalSy Δ${m3b.totalSy - m3.totalSy} totalPt Δ${m3b.totalPt - m3.totalPt}`);
} catch (e) {
  record("3 swapExactPtForSy", "FAIL", e.message);
}

// ───────────── Test 4: Buy YT ─────────────
console.log(`\n========================================`);
console.log(`Test 4: Buy YT via router.buyYT`);
console.log(`========================================`);
const ytBefore = await ytBalanceOf(evmAddr);
const syBal4 = (await balanceOf(shareTok, evmAddr)) ?? 0n;
const m4 = await readMarket();
console.log(`  pre: YT bal=${ytBefore} SY bal=${syBal4} totalSy=${m4.totalSy} totalPt=${m4.totalPt}`);
const SY_BUDGET = 200_000n;
const MIN_SY_REFUND = 1n; // accept any refund
try {
  const approveTx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, shareTok)).setGas(800_000).setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(ROUTER).addUint256(SY_BUDGET.toString()));
  await (await approveTx.execute(client)).getReceipt(client);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const buyTx = new ContractExecuteTransaction()
    .setContractId(ROUTER_ID).setGas(6_000_000).setMaxTransactionFee(new Hbar(30))
    .setFunction("buyYT",
      new ContractFunctionParameters()
        .addAddress(MARKET).addUint256(SY_BUDGET.toString()).addUint256(MIN_SY_REFUND.toString())
        .addAddress(evmAddr).addUint256(deadline.toString()));
  const sub = await buyTx.execute(client);
  const rec = await sub.getReceipt(client);
  await sleep(6000);
  const ytAfter = await ytBalanceOf(evmAddr);
  const syAfter = (await balanceOf(shareTok, evmAddr)) ?? 0n;
  const m4b = await readMarket();
  const status = rec.status.toString();
  const ok = status === "SUCCESS" && ytAfter > ytBefore;
  record("4 buyYT", ok ? "PASS" : "FAIL",
    `tx=${sub.transactionId.toString()} status=${status} YT Δ${ytAfter - ytBefore} SY Δ${syAfter - syBal4} (refund-accounting) totalSy Δ${m4b.totalSy - m4.totalSy} totalPt Δ${m4b.totalPt - m4.totalPt}`);
} catch (e) {
  record("4 buyYT", "FAIL", e.message);
}

// ───────────── Test 5: Sell YT (THE BIG ONE) ─────────────
console.log(`\n========================================`);
console.log(`Test 5: swapExactYtForSy direct on market (NEW function)`);
console.log(`========================================`);
const ytBefore5 = await ytBalanceOf(evmAddr);
const syBal5 = (await balanceOf(shareTok, evmAddr)) ?? 0n;
const m5 = await readMarket();
console.log(`  pre: YT bal (storage)=${ytBefore5} SY bal=${syBal5} totalSy=${m5.totalSy} totalPt=${m5.totalPt}`);
if (ytBefore5 === 0n) {
  record("5 swapExactYtForSy", "SKIP", "operator has no YT to sell (test 4 must have failed)");
} else {
  const YT_IN = ytBefore5 / 2n;
  const MIN_SY_OUT = 1n; // tiny — for ytIn this should be small (ytIn - syOwed)
  try {
    const marketContractId = ContractId.fromEvmAddress(0, 0, MARKET);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const tx = new ContractExecuteTransaction()
      .setContractId(marketContractId).setGas(3_500_000).setMaxTransactionFee(new Hbar(20))
      .setFunction("swapExactYtForSy",
        new ContractFunctionParameters()
          .addUint256(YT_IN.toString()).addUint256(MIN_SY_OUT.toString()).addAddress(evmAddr));
    const sub = await tx.execute(client);
    const rec = await sub.getReceipt(client);
    await sleep(8000);
    const ytAfter5 = await ytBalanceOf(evmAddr);
    const syAfter5 = (await balanceOf(shareTok, evmAddr)) ?? 0n;
    const m5b = await readMarket();
    const status = rec.status.toString();
    const syOut = syAfter5 - syBal5;
    const ytBurned = ytBefore5 - ytAfter5;
    const ok = status === "SUCCESS" &&
               ytBurned > 0n &&
               syOut > 0n &&
               syOut < YT_IN && // syOut = ytIn - syOwed; must be strictly less than ytIn
               m5b.totalPt < m5.totalPt &&
               m5b.totalSy > m5.totalSy;
    record("5 swapExactYtForSy", ok ? "PASS" : "FAIL",
      `tx=${sub.transactionId.toString()} status=${status} YT_IN=${YT_IN} ytBurned=${ytBurned} syOut=${syOut} (syOut<ytIn=${syOut < YT_IN}) totalSy Δ${m5b.totalSy - m5.totalSy} totalPt Δ${m5b.totalPt - m5.totalPt} last Δ${m5b.lastLnImpliedRate - m5.lastLnImpliedRate}`);
  } catch (e) {
    record("5 swapExactYtForSy", "FAIL", e.message);
  }
}

// ───────────── Test 6: Slippage revert ─────────────
console.log(`\n========================================`);
console.log(`Test 6: Slippage revert on router.swapExactPtForSy`);
console.log(`========================================`);
const ptBal6 = (await balanceOf(PT, evmAddr)) ?? 0n;
if (ptBal6 === 0n) {
  record("6 slippage revert", "SKIP", "no PT to test with");
} else {
  const PT_IN = 100_000n < ptBal6 ? 100_000n : ptBal6;
  const MIN_SY = PT_IN * 2n; // demand 2x PT — impossible
  try {
    const approveTx = new ContractExecuteTransaction()
      .setContractId(ContractId.fromEvmAddress(0, 0, PT)).setGas(800_000).setMaxTransactionFee(new Hbar(5))
      .setFunction("approve", new ContractFunctionParameters().addAddress(ROUTER).addUint256(PT_IN.toString()));
    await (await approveTx.execute(client)).getReceipt(client);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const swapTx = new ContractExecuteTransaction()
      .setContractId(ROUTER_ID).setGas(3_500_000).setMaxTransactionFee(new Hbar(20))
      .setFunction("swapExactPtForSy",
        new ContractFunctionParameters()
          .addAddress(MARKET).addUint256(PT_IN.toString()).addUint256(MIN_SY.toString())
          .addAddress(evmAddr).addUint256(deadline.toString()));
    let reverted = false;
    let txId = "(n/a)";
    try {
      const sub = await swapTx.execute(client);
      txId = sub.transactionId.toString();
      const rec = await sub.getReceipt(client);
      // If we get here without throw, status should not be SUCCESS for slippage
      if (rec.status.toString() !== "SUCCESS") reverted = true;
    } catch (e) {
      reverted = true;
      txId = `(reverted in execute: ${e.message.slice(0, 100)})`;
    }
    record("6 slippage revert", reverted ? "PASS" : "FAIL",
      `tx=${txId} (expected: revert when minSyOut=2*ptIn)`);
  } catch (e) {
    record("6 slippage revert", "FAIL", e.message);
  }
}

// ───────────── final summary ─────────────
console.log(`\n========================================`);
console.log(`FINAL STATE`);
console.log(`========================================`);
const endHbar = await hbarBalance();
const endMarket = await readMarket();
const endSy = (await balanceOf(shareTok, evmAddr)) ?? 0n;
const endPt = (await balanceOf(PT, evmAddr)) ?? 0n;
const endYt = await ytBalanceOf(evmAddr);
const endLp = (await balanceOf(LP, evmAddr)) ?? 0n;
console.log(`Operator HBAR: ${startHbar} → ${endHbar}  (Δ ${endHbar - startHbar})`);
console.log(`Operator SY-share: ${endSy}`);
console.log(`Operator PT: ${endPt}`);
console.log(`Operator YT (storage): ${endYt}`);
console.log(`Operator LP: ${endLp}`);
console.log(`Market totalSy: ${startMarket.totalSy} → ${endMarket.totalSy}  (Δ ${endMarket.totalSy - startMarket.totalSy})`);
console.log(`Market totalPt: ${startMarket.totalPt} → ${endMarket.totalPt}  (Δ ${endMarket.totalPt - startMarket.totalPt})`);
console.log(`lastLnImpliedRate: ${startMarket.lastLnImpliedRate} → ${endMarket.lastLnImpliedRate}`);

console.log(`\n========================================`);
console.log(`RESULTS`);
console.log(`========================================`);
for (const r of results) {
  console.log(`[${r.status.padEnd(4)}] ${r.name}`);
  console.log(`        ${r.detail}`);
}

client.close();
