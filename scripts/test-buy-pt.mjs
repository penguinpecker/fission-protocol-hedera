#!/usr/bin/env node
// Smoke-test the Buy PT flow end-to-end from the operator:
//   1. Read current SY share balance.
//   2. Approve a small portion to the ActionRouter.
//   3. Call router.swapExactSyForPt(market, syIn, minPtOut, receiver, deadline).
//   4. Read PT balance delta to confirm.

import {
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  PrivateKey,
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

const deploy = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
const MARKET = deploy.markets[0].evm;
const ROUTER = process.env.ROUTER || deploy.router.evm;
const SY = deploy.sy_saucer_v2_lp.evm;

// Resolve SY shareToken via eth_call
async function shareToken() {
  const r = await fetch("https://mainnet.hashio.io/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SY, data: "0x6c9fa59e" }, "latest"] }),
  }).then((r) => r.json());
  return "0x" + r.result.slice(26);
}
async function balanceOf(tokenAddr, who) {
  const data = "0x70a08231" + who.replace(/^0x/, "").padStart(64, "0");
  const r = await fetch("https://mainnet.hashio.io/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: tokenAddr, data }, "latest"] }),
  }).then((r) => r.json());
  return BigInt(r.result || "0x0");
}
async function ptAddr() {
  const r = await fetch("https://mainnet.hashio.io/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MARKET, data: "0xdc263022" }, "latest"] }),
  }).then((r) => r.json());
  return "0x" + r.result.slice(26);
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
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr) {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

const shareTok = await shareToken();
const pt = await ptAddr();
const syBefore = await balanceOf(shareTok, evmAddr);
const ptBefore = await balanceOf(pt, evmAddr);
console.log(`Op:           ${evmAddr}`);
console.log(`SY share tok: ${shareTok}`);
console.log(`PT tok:       ${pt}`);
console.log(`Market:       ${MARKET}`);
console.log(`Router:       ${ROUTER}`);
console.log(`SY balance:   ${syBefore}`);
console.log(`PT balance:   ${ptBefore}`);

const SY_IN = BigInt(process.env.SY_IN ?? "1000000"); // 1M raw shares default
if (SY_IN > syBefore) throw new Error(`SY_IN (${SY_IN}) > balance (${syBefore})`);
const MIN_PT_OUT = (SY_IN * 9950n) / 10_000n; // 0.5% slippage
const deadline = Math.floor(Date.now() / 1000) + 600;

console.log(`\nPlan: spend ${SY_IN} SY → expect ≥${MIN_PT_OUT} PT`);

// 1) Approve SY shareToken to Router
console.log(`\n[1] shareToken.approve(router, ${SY_IN})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, shareTok))
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(ROUTER).addUint256(SY_IN.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// 2) router.swapExactSyForPt
console.log(`\n[2] router.swapExactSyForPt(${MARKET}, ${SY_IN}, ${MIN_PT_OUT}, op, ${deadline})…`);
const routerId = ContractId.fromEvmAddress(0, 0, ROUTER);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(routerId)
    .setGas(3_500_000)
    .setMaxTransactionFee(new Hbar(20))
    .setFunction(
      "swapExactSyForPt",
      new ContractFunctionParameters()
        .addAddress(MARKET)
        .addUint256(SY_IN.toString())
        .addUint256(MIN_PT_OUT.toString())
        .addAddress(evmAddr)
        .addUint256(deadline.toString())
    );
  const submit = await tx.execute(client);
  const r = await submit.getReceipt(client);
  console.log(`   Status: ${r.status.toString()}`);
  console.log(`   Tx:     ${submit.transactionId.toString()}`);
}

const syAfter = await balanceOf(shareTok, evmAddr);
const ptAfter = await balanceOf(pt, evmAddr);
console.log(`\nResult:`);
console.log(`   SY  ${syBefore} → ${syAfter}  (Δ ${syAfter - syBefore})`);
console.log(`   PT  ${ptBefore} → ${ptAfter}  (Δ ${ptAfter - ptBefore})`);

client.close();
