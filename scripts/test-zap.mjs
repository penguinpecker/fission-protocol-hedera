#!/usr/bin/env node
// Smoke-test FissionZap on mainnet by zapping a small amount of HBAR → SY.
// Captures the operator's SY share balance before/after so we can confirm
// the zap actually minted shares.
//
// Usage:
//   HBAR_AMOUNT=10 node scripts/test-zap.mjs

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
const ZAP = deploy.fission_zap.evm;
const ZAP_ID = ContractId.fromString(deploy.fission_zap.id);
const SY = deploy.sy_saucer_v2_lp.evm;

const HBAR_AMOUNT = Number(process.env.HBAR_AMOUNT ?? "10"); // wrap target
const NPM_HBAR = 5; // additional for V3 NPM fee inside SY

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

// Resolve SY shareToken address via eth_call
async function shareToken() {
  const r = await fetch("https://mainnet.hashio.io/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SY, data: "0x6c9fa59e" }, "latest"] }),
  }).then(r => r.json());
  return "0x" + r.result.slice(26);
}
async function balanceOf(tokenAddr, who = evmAddr) {
  const data = "0x70a08231" + who.replace(/^0x/, "").padStart(64, "0");
  const r = await fetch("https://mainnet.hashio.io/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: tokenAddr, data }, "latest"] }),
  }).then(r => r.json());
  return BigInt(r.result || "0x0");
}

console.log(`Zap: ${ZAP}`);
console.log(`SY:  ${SY}`);
console.log(`Op:  ${evmAddr} / ${operatorIdStr}`);
console.log(`Plan: wrap ${HBAR_AMOUNT} HBAR, swap half→USDC, deposit; +${NPM_HBAR} HBAR NPM fee`);

const shareTok = await shareToken();
console.log(`SY shareToken: ${shareTok}`);
const balBefore = await balanceOf(shareTok);
console.log(`SY balance before: ${balBefore}`);

// Sizes in raw units. wrapAmount in wei (1 HBAR = 1e18 wei on Hedera EVM).
// swapAmount in WHBAR raw (1 HBAR = 1e8 WHBAR raw); use half of wrapped.
const wrapWei = BigInt(HBAR_AMOUNT) * 10n ** 18n;
const wrapWhbarRaw = BigInt(HBAR_AMOUNT) * 10n ** 8n;
const swapRaw = wrapWhbarRaw / 2n;
const msgValueHbar = HBAR_AMOUNT + NPM_HBAR;

console.log(`\nBroadcasting zap…`);
// New signature: (sy, usdcMinOut, amount0Min, amount1Min, minShares, receiver)
const params = new ContractFunctionParameters()
  .addAddress(SY)
  .addUint256("0") // usdcMinOut — wide
  .addUint256("0") // amount0Min
  .addUint256("0") // amount1Min
  .addUint128("1") // minShares
  .addAddress(evmAddr);

// msgValueHbar HBAR is forwarded to the contract; contract reserves 5 HBAR
// for NPM, wraps the rest, splits half to USDC.
const tx = new ContractExecuteTransaction()
  .setContractId(ZAP_ID)
  .setGas(14_500_000) // close to mainnet cap
  .setMaxTransactionFee(new Hbar(50))
  .setPayableAmount(new Hbar(msgValueHbar))
  .setFunction("zapHbarToSy", params);
const sub = await tx.execute(client);
const rec = await sub.getReceipt(client);
console.log(`  Status: ${rec.status.toString()}`);
console.log(`  Tx:     ${sub.transactionId.toString()}`);

const balAfter = await balanceOf(shareTok);
console.log(`\nSY balance after: ${balAfter}`);
console.log(`Shares minted:    ${balAfter - balBefore}`);

client.close();
