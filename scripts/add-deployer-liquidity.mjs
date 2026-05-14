#!/usr/bin/env node
/**
 * Add liquidity to Market 0 (Fission AMM PT/SY pool) from the deployer's HBAR.
 *
 * Path A — split-and-LP. Per chunk:
 *   1. FissionZap.zapHbarToSy{value: N HBAR}(SY, 0, 0, 0, 1, deployer)
 *       → mints X SY shares to deployer (~5 HBAR reserved for V3 NPM fee).
 *   2. eth_call market.totalSy() / totalPt() → ratio R = totalSy/totalPt.
 *   3. splitAmt = X / (1 + R)
 *      → market.split(splitAmt) mints (splitAmt) PT + YT to deployer.
 *   4. addLiquidity(X - splitAmt, splitAmt, 1, deployer)
 *      → both reserves grow; LP minted to deployer; YT residue retained.
 *
 * Modes: DRY_RUN=true (default) prints the plan, no broadcasts.
 *        DRY_RUN=false executes for real.
 *
 * Env knobs:
 *   CHUNKS=4               number of chunks
 *   HBAR_PER_CHUNK=2750    HBAR sent per chunk
 *   DRY_RUN=true|false
 */

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

const CHUNKS = Number(process.env.CHUNKS ?? "4");
const HBAR_PER_CHUNK = Number(process.env.HBAR_PER_CHUNK ?? "2750");
const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
// RESUME_BASELINE: if set, chunk 1 skips the zap (assumes it already happened)
// and uses (current SY-share balance - RESUME_BASELINE) as X.
const RESUME_BASELINE = process.env.RESUME_BASELINE ? BigInt(process.env.RESUME_BASELINE) : null;

const FISSION_ZAP = "0x00000000000000000000000000000000009fd984";
const SY_ADDR     = "0x00000000000000000000000000000000009fb089";
const SY_SHARE    = "0x00000000000000000000000000000000009fb08b";
const MARKET      = "0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d";
const PT_TOKEN    = "0x00000000000000000000000000000000009fb0b5";
const LP_TOKEN    = "0x00000000000000000000000000000000009fb0b7";
const V3_POOL     = "0xC5B707348dA504E9Be1bD4E21525459830e7B11d"; // WHBAR/USDC 0.15%
const NPM_FEE_TINYBARS = 500_000_000n;  // 5 HBAR reserved by zap for V3 NPM
const POOL_FEE_BPS = 15n;  // 0.15%
const SLIP_BPS = 50n;      // 0.5% on top of pool fee

const MIRROR = "https://mainnet-public.mirrornode.hedera.com/api/v1";
const HASHIO = "https://mainnet.hashio.io/api";

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`${MIRROR}/accounts/${evmAddr}`).then(r => r.json());
  operatorIdStr = r.account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

async function lookup(addr) {
  const j = await fetch(`${MIRROR}/contracts/${addr}`).then(r => r.json());
  if (!j.contract_id) throw new Error(`no contract at ${addr}`);
  return ContractId.fromString(j.contract_id);
}
async function ethCall(to, data) {
  const j = await fetch(HASHIO, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  }).then(r => r.json());
  if (j.error) throw new Error(`eth_call ${to} ${data}: ${j.error.message}`);
  return j.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read balance via Mirror Node. Mirror is the freshest source for HTS state —
// Hashio's eth_call caches HTS balances within a block boundary and will return
// stale values right after a tx that did successfully credit/debit the wallet.
// Mirror's own indexing lag is typically 3-8s after consensus.
async function balanceOf(tokenEvm) {
  const tokenId = `0.0.${parseInt(tokenEvm.replace(/^0x/, ""), 16)}`;
  const j = await fetch(`${MIRROR}/accounts/${evmAddr}/tokens?token.id=${tokenId}`).then((r) => r.json());
  const t = (j.tokens || []).find((x) => x.token_id === tokenId);
  return BigInt(t?.balance ?? 0);
}

// Poll mirror until balance differs from `before`, or timeout.
async function balanceOfAfterChange(tokenEvm, before, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const cur = await balanceOf(tokenEvm);
    if (cur !== before) return cur;
    await sleep(1500);
  }
  return await balanceOf(tokenEvm);
}

// Read contract state via eth_call after sleeping past Hashio's block-boundary
// cache. Used for storage reads (totalSy/totalPt) where mirror has no clean
// equivalent. ~8s typically suffices.
async function ethCallFresh(to, data) {
  await sleep(8000);
  return ethCall(to, data);
}
async function hbarBalance() {
  // eth_getBalance returns balance in WEI (1e18); Hedera tinybars are 1e8.
  // The Hashio RPC returns "0x..." weibars-equivalent. We want raw tinybars.
  const r = await fetch(HASHIO, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [evmAddr, "latest"] }),
  }).then(r => r.json());
  // weibars = tinybars * 1e10. Convert back to tinybars.
  return BigInt(r.result) / 10_000_000_000n;
}
async function readPoolState(fresh = false) {
  const callFn = fresh ? ethCallFresh : ethCall;
  const sy = BigInt(await callFn(MARKET, "0xc7bfb21e")); // totalSy()
  const pt = BigInt(await callFn(MARKET, "0xb4b9106d")); // totalPt()
  return { totalSy: sy, totalPt: pt };
}

// V3 pool slot0() → sqrtPriceX96. Pool sorts token0 < token1: token0=USDC(0x...6f89a), token1=WHBAR(0x...163b5a).
// price = sqrtPriceX96^2 / 2^192 = raw WHBAR per raw USDC.
// WHBAR→USDC quote: usdcOut = whbarIn * 2^192 / sqrtPriceX96^2.
async function quoteWhbarToUsdc(whbarIn) {
  const slot0 = await ethCall(V3_POOL, "0x3850c7bd");
  const sqrtPriceX96 = BigInt("0x" + slot0.slice(2, 66));
  const sqp2 = sqrtPriceX96 * sqrtPriceX96;
  const usdcSpot = (whbarIn * (1n << 192n)) / sqp2;
  const afterFee = (usdcSpot * (10000n - POOL_FEE_BPS)) / 10000n;
  const minOut = (afterFee * (10000n - SLIP_BPS)) / 10000n;
  return { sqrtPriceX96, usdcSpot, afterFee, minOut };
}

const zapId      = await lookup(FISSION_ZAP);
const marketId   = await lookup(MARKET);
const syShareId  = ContractId.fromEvmAddress(0, 0, SY_SHARE);
const ptId       = ContractId.fromEvmAddress(0, 0, PT_TOKEN);

console.log("============================================================");
console.log(` Add Deployer Liquidity — Market 0 (Path A: split-and-LP)`);
console.log("============================================================");
console.log(`Operator      : ${operatorIdStr} / ${evmAddr}`);
console.log(`Mode          : ${DRY_RUN ? "DRY-RUN (no broadcast)" : "LIVE (broadcasting)"}`);
console.log(`Chunks        : ${CHUNKS} × ${HBAR_PER_CHUNK} HBAR = ${CHUNKS * HBAR_PER_CHUNK} HBAR total`);
console.log(`FissionZap    : ${FISSION_ZAP}`);
console.log(`Market        : ${MARKET}`);
console.log(`SY share token: ${SY_SHARE}`);
console.log(`PT token      : ${PT_TOKEN}`);
console.log(`LP token      : ${LP_TOKEN}`);
console.log();

const hbarBefore = await hbarBalance();
const lpBefore = await balanceOf(LP_TOKEN);
const syShareBefore = await balanceOf(SY_SHARE);
const ptBefore = await balanceOf(PT_TOKEN);
console.log(`Deployer HBAR before : ${Number(hbarBefore)/1e8} HBAR`);
console.log(`Deployer LP before   : ${lpBefore} raw`);
console.log(`Deployer SY-sh before: ${syShareBefore} raw`);
console.log(`Deployer PT before   : ${ptBefore} raw`);

const zappingChunks = RESUME_BASELINE !== null ? CHUNKS - 1 : CHUNKS;
const requiredHbar = BigInt(zappingChunks * HBAR_PER_CHUNK + 100) * 10n**8n; // +100 HBAR slack for gas
if (hbarBefore < requiredHbar) {
  throw new Error(`Insufficient HBAR: have ${Number(hbarBefore)/1e8}, need ~${Number(requiredHbar)/1e8} (with slack).`);
}

const ps0 = await readPoolState();
const R0 = Number(ps0.totalSy * 10000n / ps0.totalPt) / 10000;
console.log();
console.log(`Pool state (pre-run): totalSy=${ps0.totalSy}, totalPt=${ps0.totalPt}, R=${R0.toFixed(4)}`);
console.log();

for (let i = 1; i <= CHUNKS; i++) {
  console.log(`──────── chunk ${i}/${CHUNKS} (${HBAR_PER_CHUNK} HBAR) ────────`);

  // After the first chunk, wait for Hashio's per-block cache to clear so
  // pool-state reads reflect the previous chunk's addLiquidity.
  const ps = await readPoolState(i > 1 && !DRY_RUN);
  const R_e18 = (ps.totalSy * 10n**18n) / ps.totalPt;
  const R = Number(R_e18) / 1e18;
  console.log(`pool: totalSy=${ps.totalSy}, totalPt=${ps.totalPt}, R=${R.toFixed(4)}`);

  // Fresh V3 quote for the upstream WHBAR→USDC swap
  const msgValueTinybars = BigInt(HBAR_PER_CHUNK) * 100_000_000n;
  const wrapAmount = msgValueTinybars - NPM_FEE_TINYBARS;
  const swapAmountWhbar = wrapAmount / 2n;
  const q = await quoteWhbarToUsdc(swapAmountWhbar);
  console.log(`v3 quote: swap ${Number(swapAmountWhbar)/1e8} WHBAR -> ${Number(q.afterFee)/1e6} USDC (minOut ${Number(q.minOut)/1e6} @ 0.5% slip)`);

  const isResume = (i === 1 && RESUME_BASELINE !== null);
  const syBefore = isResume ? RESUME_BASELINE : await balanceOf(SY_SHARE);

  // STEP 1 — zapHbarToSy (skipped on resume)
  if (isResume) {
    console.log(`step 1: SKIPPED (RESUME mode — assuming zap already executed; baseline ${RESUME_BASELINE})`);
  } else {
    console.log(`step 1: FissionZap.zapHbarToSy{value: ${HBAR_PER_CHUNK} HBAR}(SY, ${q.minOut}, 0, 0, 1, deployer)`);
    if (!DRY_RUN) {
      const tx = new ContractExecuteTransaction()
        .setContractId(zapId)
        .setGas(15_000_000)
        .setMaxTransactionFee(new Hbar(40))
        .setPayableAmount(new Hbar(HBAR_PER_CHUNK))
        .setFunction("zapHbarToSy",
          new ContractFunctionParameters()
            .addAddress(SY_ADDR)
            .addUint256(q.minOut.toString())
            .addUint256("0")
            .addUint256("0")
            .addUint128("1")
            .addAddress(evmAddr));
      const r = await (await tx.execute(client)).getReceipt(client);
      console.log(`        -> ${r.status}`);
    } else {
      console.log(`        -> [DRY-RUN] would broadcast`);
    }
  }

  const syAfter = DRY_RUN ? syBefore : (isResume ? await balanceOf(SY_SHARE) : await balanceOfAfterChange(SY_SHARE, syBefore));
  const X = syAfter - syBefore;
  console.log(`        SY-shares ${isResume ? "available" : "minted"} (X) = ${DRY_RUN ? "(unknown until live)" : X.toString()}`);

  // splitAmt = X / (1+R); syKeep = X - splitAmt
  const splitAmt = DRY_RUN ? null : (X * 10n**18n) / (10n**18n + R_e18);
  const syKeep   = DRY_RUN ? null : X - splitAmt;
  if (DRY_RUN) {
    console.log(`        splitAmt = X / (1 + R) = X / ${(1+R).toFixed(4)}`);
    console.log(`        syKeep   = X - splitAmt`);
  } else {
    console.log(`        splitAmt = ${splitAmt}  (mints ${splitAmt} PT + ${splitAmt} YT)`);
    console.log(`        syKeep   = ${syKeep}  (will be addLiquidity SY-side)`);
  }

  // STEP 2 — approve SY-share to market (covers split + addLiquidity)
  console.log(`step 2: SYshareToken.approve(market, X)`);
  if (!DRY_RUN) {
    const tx = new ContractExecuteTransaction()
      .setContractId(syShareId)
      .setGas(800_000)
      .setMaxTransactionFee(new Hbar(5))
      .setFunction("approve",
        new ContractFunctionParameters().addAddress(MARKET).addUint256(X.toString()));
    const r = await (await tx.execute(client)).getReceipt(client);
    console.log(`        -> ${r.status}`);
  } else {
    console.log(`        -> [DRY-RUN] would broadcast`);
  }

  // STEP 3 — market.split
  console.log(`step 3: market.split(splitAmt)`);
  if (!DRY_RUN) {
    const tx = new ContractExecuteTransaction()
      .setContractId(marketId)
      .setGas(2_000_000)
      .setMaxTransactionFee(new Hbar(15))
      .setFunction("split",
        new ContractFunctionParameters().addUint256(splitAmt.toString()));
    const r = await (await tx.execute(client)).getReceipt(client);
    console.log(`        -> ${r.status}`);
  } else {
    console.log(`        -> [DRY-RUN] would broadcast`);
  }

  // STEP 4 — approve PT to market
  console.log(`step 4: PT.approve(market, splitAmt)`);
  if (!DRY_RUN) {
    const tx = new ContractExecuteTransaction()
      .setContractId(ptId)
      .setGas(800_000)
      .setMaxTransactionFee(new Hbar(5))
      .setFunction("approve",
        new ContractFunctionParameters().addAddress(MARKET).addUint256(splitAmt.toString()));
    const r = await (await tx.execute(client)).getReceipt(client);
    console.log(`        -> ${r.status}`);
  } else {
    console.log(`        -> [DRY-RUN] would broadcast`);
  }

  // STEP 5 — market.addLiquidity
  console.log(`step 5: market.addLiquidity(syKeep, splitAmt, 1, deployer)`);
  if (!DRY_RUN) {
    const tx = new ContractExecuteTransaction()
      .setContractId(marketId)
      .setGas(2_000_000)
      .setMaxTransactionFee(new Hbar(15))
      .setFunction("addLiquidity",
        new ContractFunctionParameters()
          .addUint256(syKeep.toString())
          .addUint256(splitAmt.toString())
          .addUint256("1")
          .addAddress(evmAddr));
    const r = await (await tx.execute(client)).getReceipt(client);
    console.log(`        -> ${r.status}`);
  } else {
    console.log(`        -> [DRY-RUN] would broadcast`);
  }

  console.log();
}

console.log("──────── final summary ────────");
if (!DRY_RUN) await sleep(8000); // let last addLiquidity propagate
const psF = await readPoolState();
const lpAfter = await balanceOf(LP_TOKEN);
const ptAfter = await balanceOf(PT_TOKEN);
const syShareAfter = await balanceOf(SY_SHARE);
const hbarAfter = await hbarBalance();
console.log(`pool: totalSy ${ps0.totalSy} -> ${psF.totalSy} (Δ ${psF.totalSy - ps0.totalSy})`);
console.log(`pool: totalPt ${ps0.totalPt} -> ${psF.totalPt} (Δ ${psF.totalPt - ps0.totalPt})`);
console.log(`Deployer LP   : ${lpBefore} -> ${lpAfter} (Δ ${lpAfter - lpBefore})`);
console.log(`Deployer PT   : ${ptBefore} -> ${ptAfter} (Δ ${ptAfter - ptBefore})`);
console.log(`Deployer SY-sh: ${syShareBefore} -> ${syShareAfter} (Δ ${syShareAfter - syShareBefore})`);
console.log(`Deployer HBAR : ${Number(hbarBefore)/1e8} -> ${Number(hbarAfter)/1e8} (Δ ${Number(hbarAfter - hbarBefore)/1e8})`);
console.log();
if (DRY_RUN) {
  console.log("[DRY-RUN complete] No transactions broadcast. Re-run with DRY_RUN=false to execute.");
} else {
  console.log("[LIVE complete]");
}
process.exit(0);
