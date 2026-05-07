#!/usr/bin/env node
// Top up Market 0 (already-initialized SaucerSwap V2 LP rewards market) with
// additional proportional liquidity, signed entirely by the operator EOA.
//
// Pipeline (mirrors initialize-saucer-market.mjs through step 5; step 6 is
// addLiquidity instead of initialize since the market is already live):
//   1. Wrap HBAR → WHBAR.
//   2. Swap part of the WHBAR → USDC via SaucerSwap V2 SwapRouter.
//   3. Approve both tokens to SY.
//   4. SY.depositLiquidity(usdc, whbar, …) → mint SY shares.
//   5. Split half the new SY shares → PT + YT.
//   6. Approve SY remainder + PT to market; market.addLiquidity(syIn, ptIn, 0, operator).
//
// Env (defaults match initialize-saucer-market.mjs):
//   HBAR_TO_WRAP=100               (total HBAR to commit)
//   HBAR_TO_SWAP_FOR_USDC=50       (half goes to USDC, half stays as WHBAR)
//   USDC_AMOUNT_OUT_MIN=4000000    (~$4 USDC; protects against bad slippage)
//   MARKET_ADDRESS                 (defaults to deployments/295.json markets[0].evm)
//   SY_SAUCER_V2_LP_ADDRESS        (defaults to deployments/295.json sy_saucer_v2_lp.evm)
//   SKIP_WRAP=1, SKIP_SWAP=1       — resume flags

import {
  AccountId, AccountUpdateTransaction,
  Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId,
  Hbar, PrivateKey,
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

function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}

const WHBAR_CONTRACT = "0x0000000000000000000000000000000000163b59";
const WHBAR_TOKEN    = "0x0000000000000000000000000000000000163b5a";
const USDC_TOKEN     = "0x000000000000000000000000000000000006f89a";
const V2_SWAP_ROUTER = "0x00000000000000000000000000000000003c437a";
const POOL_FEE = 1500;

const deploy = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
const MARKET_ADDRESS = process.env.MARKET_ADDRESS || deploy.markets[0].evm;
const SY_ADDRESS     = process.env.SY_SAUCER_V2_LP_ADDRESS || deploy.sy_saucer_v2_lp.evm;

const HBAR_TO_WRAP = Number(process.env.HBAR_TO_WRAP ?? "100");
const HBAR_TO_SWAP = Number(process.env.HBAR_TO_SWAP_FOR_USDC ?? "50");
const USDC_OUT_MIN = process.env.USDC_AMOUNT_OUT_MIN ?? "4000000";

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

async function lookup(addr) {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${addr}`);
  const j = await r.json();
  if (!j.contract_id) throw new Error(`no contract at ${addr}`);
  return ContractId.fromString(j.contract_id);
}
async function balanceOf(tokenAddr) {
  const tokenId = `0.0.${parseInt(tokenAddr.replace(/^0x/, ""), 16)}`;
  const r = await fetch(
    `https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}/tokens?token.id=${tokenId}`,
  ).then((r) => r.json());
  const t = (r.tokens || []).find((x) => x.token_id === tokenId);
  return BigInt(t?.balance ?? 0);
}

console.log(`Operator: ${operatorIdStr} / ${evmAddr}`);
console.log(`Market:   ${MARKET_ADDRESS}`);
console.log(`SY:       ${SY_ADDRESS}`);
console.log(`Plan:     wrap ${HBAR_TO_WRAP} HBAR, swap ${HBAR_TO_SWAP} → USDC, deposit, split, addLiquidity`);

// ── 0. HIP-904 unlimited auto-associations (idempotent) ──
console.log(`\n[0] AccountUpdate.setMaxAutomaticTokenAssociations(-1)…`);
{
  const tx = await new AccountUpdateTransaction()
    .setAccountId(AccountId.fromString(operatorIdStr))
    .setMaxAutomaticTokenAssociations(-1)
    .setMaxTransactionFee(new Hbar(2))
    .freezeWith(client)
    .sign(operatorKey);
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// ── 1. Wrap HBAR → WHBAR ──
const whbarContractId = await lookup(WHBAR_CONTRACT);
const whbarTokenId = ContractId.fromEvmAddress(0, 0, WHBAR_TOKEN);
if (process.env.SKIP_WRAP === "1") {
  console.log(`\n[1] SKIP_WRAP=1`);
} else {
  console.log(`\n[1] Wrap ${HBAR_TO_WRAP} HBAR → WHBAR…`);
  const tx = new ContractExecuteTransaction()
    .setContractId(whbarContractId)
    .setGas(300_000)
    .setMaxTransactionFee(new Hbar(2))
    .setPayableAmount(new Hbar(HBAR_TO_WRAP))
    .setFunction("deposit");
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// ── 2. Swap WHBAR → USDC ──
const WHBAR_TO_SWAP_RAW = BigInt(HBAR_TO_SWAP) * 10n ** 8n;
if (process.env.SKIP_SWAP === "1") {
  console.log(`\n[2] SKIP_SWAP=1`);
} else {
  console.log(`\n[2a] WHBAR.approve(router, ${WHBAR_TO_SWAP_RAW})…`);
  {
    const tx = new ContractExecuteTransaction()
      .setContractId(whbarTokenId)
      .setGas(800_000)
      .setMaxTransactionFee(new Hbar(5))
      .setFunction(
        "approve",
        new ContractFunctionParameters()
          .addAddress(V2_SWAP_ROUTER)
          .addUint256(WHBAR_TO_SWAP_RAW.toString()),
      );
    const r = await (await tx.execute(client)).getReceipt(client);
    console.log(`   ${r.status.toString()}`);
  }
  console.log(`\n[2b] router.exactInputSingle(WHBAR→USDC)…`);
  const routerId = await lookup(V2_SWAP_ROUTER);
  const deadline = (Math.floor(Date.now() / 1000) + 600).toString();
  {
    const pad = (h, n = 64) => h.replace(/^0x/, "").padStart(n, "0");
    const tuple = Buffer.from(
      [
        WHBAR_TOKEN,
        USDC_TOKEN,
        POOL_FEE,
        evmAddr,
        deadline,
        WHBAR_TO_SWAP_RAW.toString(),
        USDC_OUT_MIN,
        "0",
      ]
        .map((v, i) => {
          if (i === 0 || i === 1 || i === 3) return pad(String(v).toLowerCase().replace(/^0x/, ""));
          return pad(BigInt(v).toString(16));
        })
        .join(""),
      "hex",
    );
    const selector = Buffer.from("414bf389", "hex"); // exactInputSingle (V3 SwapRouter01 form)
    const tx = new ContractExecuteTransaction()
      .setContractId(routerId)
      .setGas(2_000_000)
      .setMaxTransactionFee(new Hbar(15))
      .setFunctionParameters(Buffer.concat([selector, tuple]));
    const r = await (await tx.execute(client)).getReceipt(client);
    console.log(`   ${r.status.toString()}`);
  }
}

// ── 3. Approve SY for both tokens ──
const usdcBal = await balanceOf(USDC_TOKEN);
const whbarBal = await balanceOf(WHBAR_TOKEN);
console.log(`\n   Holdings: ${usdcBal} USDC raw (${Number(usdcBal) / 1e6}), ${whbarBal} WHBAR raw (${Number(whbarBal) / 1e8})`);
if (process.env.SKIP_DEPOSIT !== "1") {
  if (usdcBal === 0n) throw new Error("USDC balance is 0 — abort");
  if (whbarBal === 0n) throw new Error("WHBAR balance is 0 — abort");
}

if (process.env.SKIP_DEPOSIT === "1") {
  console.log(`\n[3] SKIP_DEPOSIT=1 — skipping approves`);
} else {
console.log(`\n[3a] USDC.approve(SY, ${usdcBal})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, USDC_TOKEN))
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(SY_ADDRESS).addUint256(usdcBal.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
console.log(`[3b] WHBAR.approve(SY, ${whbarBal})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(whbarTokenId)
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(SY_ADDRESS).addUint256(whbarBal.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
} // end if (!SKIP_DEPOSIT)

// ── 4. SY.depositLiquidity ──
const syId = await lookup(SY_ADDRESS);
if (process.env.SKIP_DEPOSIT === "1") {
  console.log(`\n[4] SKIP_DEPOSIT=1`);
} else {
  console.log(`\n[4] SY.depositLiquidity(${usdcBal} USDC, ${whbarBal} WHBAR, 0, 0, op, 1)…`);
  const tx = new ContractExecuteTransaction()
    .setContractId(syId)
    .setGas(15_000_000)
    .setMaxTransactionFee(new Hbar(40))
    .setPayableAmount(new Hbar(5))
    .setFunction(
      "depositLiquidity",
      new ContractFunctionParameters()
        .addUint256(usdcBal.toString())
        .addUint256(whbarBal.toString())
        .addUint256("0")
        .addUint256("0")
        .addAddress(evmAddr)
        .addUint128("1"),
    );
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// Resolve shareToken via eth_call (HTS, ERC-20 facade for transfer/approve).
const shareTokenRes = await fetch("https://mainnet.hashio.io/api", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: SY_ADDRESS, data: "0x6c9fa59e" /* shareToken() */ }, "latest"],
  }),
}).then((r) => r.json());
const shareToken = "0x" + shareTokenRes.result.slice(26);
const shareBal = await balanceOf(shareToken);
console.log(`\n   New SY shares minted: ${shareBal}`);
if (shareBal < 1000n) throw new Error("Too few SY shares to split — increase HBAR_TO_WRAP.");

// ── 5. Split half ──
const SY_TO_SPLIT = shareBal / 2n;
const SY_REMAIN = shareBal - SY_TO_SPLIT;
const marketId = await lookup(MARKET_ADDRESS);
const shareTokenId = ContractId.fromEvmAddress(0, 0, shareToken);

console.log(`\n[5a] shareToken.approve(market, ${SY_TO_SPLIT})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(shareTokenId)
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET_ADDRESS).addUint256(SY_TO_SPLIT.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
console.log(`[5b] market.split(${SY_TO_SPLIT})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(marketId)
    .setGas(2_000_000)
    .setMaxTransactionFee(new Hbar(15))
    .setFunction("split", new ContractFunctionParameters().addUint256(SY_TO_SPLIT.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// ── 6. addLiquidity (NOT initialize — market is already live) ──
const ptRes = await fetch("https://mainnet.hashio.io/api", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: MARKET_ADDRESS, data: "0xdc263022" /* pt() */ }, "latest"],
  }),
}).then((r) => r.json());
const pt = "0x" + ptRes.result.slice(26);

const SY_IN = SY_REMAIN;
const PT_IN = SY_TO_SPLIT; // split mints PT 1:1 from SY

console.log(`\n[6a] shareToken.approve(market, ${SY_IN}) for addLiquidity…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(shareTokenId)
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET_ADDRESS).addUint256(SY_IN.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
console.log(`[6b] PT.approve(market, ${PT_IN})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, pt))
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET_ADDRESS).addUint256(PT_IN.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
console.log(`[6c] market.addLiquidity(syIn=${SY_IN}, ptIn=${PT_IN}, minLp=0, op)…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(marketId)
    .setGas(3_000_000)
    .setMaxTransactionFee(new Hbar(20))
    .setFunction(
      "addLiquidity",
      new ContractFunctionParameters()
        .addUint256(SY_IN.toString())
        .addUint256(PT_IN.toString())
        .addUint256("0")
        .addAddress(evmAddr),
    );
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

console.log(`\n✓ Top-up complete.`);
console.log(`   pt:         ${pt}`);
console.log(`   shareToken: ${shareToken}`);
client.close();
