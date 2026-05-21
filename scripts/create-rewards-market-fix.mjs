#!/usr/bin/env node
// One-shot: createRewardsMarket on the NEW factory for the existing SY_SaucerSwapV2LP.
// Targets the 2026-05-22 Ed25519-fix redeploy.

import { Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId, Hbar, PrivateKey } from "@hashgraph/sdk";
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
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq < 0) continue;
    const k = t.slice(0, eq).trim(); let v = t.slice(eq+1).trim();
    if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

function deriveKeyHex() {
  if (process.env.HEDERA_OPERATOR_KEY) return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/, "");
  const seed = process.env.SEED_PHRASE;
  if (!validateMnemonic(seed, wordlist)) throw new Error("bad SEED_PHRASE");
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0");
  return Buffer.from(child.privateKey).toString("hex");
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(20));

const FACTORY = process.env.FACTORY_ID || "0.0.10488654";
const SY_SAUCER = process.env.SY_SAUCER_V2_LP_ADDRESS || "0x00000000000000000000000000000000009fb089";
const EXPIRY = BigInt(process.env.EXPIRY ?? (Math.floor(Date.now()/1000) + 90*86400));
const SCALAR_ROOT = BigInt(process.env.SCALAR_ROOT ?? "75000000000000000000");
const SUFFIX = process.env.SUFFIX ?? "SS-V2-90D-FIX";

console.log("Factory   :", FACTORY);
console.log("SY        :", SY_SAUCER);
console.log("Expiry    :", EXPIRY.toString(), "(" + new Date(Number(EXPIRY)*1000).toISOString() + ")");
console.log("Scalar    :", SCALAR_ROOT.toString());
console.log("Suffix    :", SUFFIX);

const tx = await new ContractExecuteTransaction()
  .setContractId(ContractId.fromString(FACTORY))
  .setGas(15_000_000)
  .setMaxTransactionFee(new Hbar(100))
  .setPayableAmount(new Hbar(60))
  .setFunction("createRewardsMarket",
    new ContractFunctionParameters()
      .addAddress(SY_SAUCER.slice(2))
      .addUint256(EXPIRY.toString())
      .addInt256(SCALAR_ROOT.toString())
      .addString(SUFFIX))
  .execute(client);

const rec = await tx.getReceipt(client);
console.log("Status:", rec.status.toString());
console.log("TX:    ", tx.transactionId.toString());

const rcd = await tx.getRecord(client);
const r = rcd.contractFunctionResult;
if (r?.bytes) {
  const ret = "0x" + Buffer.from(r.bytes).subarray(r.bytes.length - 20).toString("hex");
  console.log("Returned market address:", ret);
}
client.close();
