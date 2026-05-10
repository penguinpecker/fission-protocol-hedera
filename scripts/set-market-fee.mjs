#!/usr/bin/env node
// Calls FissionMarketRewards.setFee(lnFeeRateRoot, reserveFeePercent) on Market 0.
// Caller must hold ADMIN_ROLE (operator EOA pre-handoff).
//
// Default: keeps current lnFeeRateRoot, sets reserveFeePercent to 1.
// Override via env: NEW_RESERVE_FEE_PERCENT (default 1), NEW_LN_FEE_RATE_ROOT (default = on-chain current).
//
// Usage:
//   node scripts/set-market-fee.mjs <market-evm-address>
//   NEW_RESERVE_FEE_PERCENT=1 node scripts/set-market-fee.mjs 0xfa90...8a6d

import {
  Client,
  ContractExecuteTransaction,
  ContractCallQuery,
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
import { keccak_256 } from "@noble/hashes/sha3";

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

const [marketEvm] = process.argv.slice(2);
if (!marketEvm?.startsWith("0x")) {
  console.error("Usage: node scripts/set-market-fee.mjs <market-evm-address>");
  process.exit(1);
}

const ADMIN_ROLE = "0x" + Buffer.from(keccak_256("ADMIN_ROLE")).toString("hex");

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
console.log(`Operator: ${evmAddr} (${operatorIdStr})`);
console.log(`ADMIN_ROLE = ${ADMIN_ROLE}`);

const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

const lookup = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${marketEvm}`);
const marketId = ContractId.fromString((await lookup.json()).contract_id);
console.log(`Market: ${marketEvm}  →  ${marketId.toString()}`);

// ---- Read current state ----
async function callQuery(name, params, returnType /* "int256" | "uint256" | "bool" */) {
  const q = new ContractCallQuery()
    .setContractId(marketId)
    .setGas(100_000)
    .setQueryPayment(new Hbar(1))
    .setFunction(name, params);
  const resp = await q.execute(client);
  if (returnType === "int256") return resp.getInt256(0);
  if (returnType === "uint256") return resp.getUint256(0);
  if (returnType === "bool") return resp.getBool(0);
  throw new Error("unknown returnType");
}

console.log("\n→ Reading current market fee config…");
const currentLnFeeRateRoot = await callQuery("lnFeeRateRoot", undefined, "int256");
const currentReserveFee = await callQuery("reserveFeePercent", undefined, "uint256");
console.log(`  lnFeeRateRoot     = ${currentLnFeeRateRoot.toString()}`);
console.log(`  reserveFeePercent = ${currentReserveFee.toString()}`);

const hasAdmin = await callQuery(
  "hasRole",
  new ContractFunctionParameters().addBytes32(Buffer.from(ADMIN_ROLE.slice(2), "hex")).addAddress(evmAddr),
  "bool"
);
console.log(`  operator hasRole(ADMIN_ROLE) = ${hasAdmin}`);
if (!hasAdmin) {
  console.error("\n✗ Operator does NOT hold ADMIN_ROLE. Cannot setFee.");
  client.close();
  process.exit(2);
}

// ---- Plan new values ----
const newReserveFeePercent = BigInt(process.env.NEW_RESERVE_FEE_PERCENT || "1");
const newLnFeeRateRoot = process.env.NEW_LN_FEE_RATE_ROOT
  ? BigInt(process.env.NEW_LN_FEE_RATE_ROOT)
  : BigInt(currentLnFeeRateRoot.toString()); // keep current

if (newReserveFeePercent > 100n) {
  console.error("✗ NEW_RESERVE_FEE_PERCENT must be 0..100");
  client.close();
  process.exit(3);
}

console.log("\n→ Planned setFee call:");
console.log(`  lnFeeRateRoot     : ${currentLnFeeRateRoot.toString()}  →  ${newLnFeeRateRoot.toString()}`);
console.log(`  reserveFeePercent : ${currentReserveFee.toString()}  →  ${newReserveFeePercent.toString()}`);

if (process.env.DRY_RUN === "1") {
  console.log("\nDRY_RUN=1 — not broadcasting.");
  client.close();
  process.exit(0);
}

console.log("\n→ Broadcasting setFee()…");
const tx = new ContractExecuteTransaction()
  .setContractId(marketId)
  .setGas(300_000)
  .setMaxTransactionFee(new Hbar(2))
  .setFunction(
    "setFee",
    new ContractFunctionParameters()
      .addInt256(newLnFeeRateRoot.toString())
      .addUint256(newReserveFeePercent.toString())
  );

const submit = await tx.execute(client);
const receipt = await submit.getReceipt(client);
console.log(`  Status: ${receipt.status.toString()}`);
console.log(`  Tx: ${submit.transactionId.toString()}`);

console.log("\n→ Verifying new state…");
const verifyLn = await callQuery("lnFeeRateRoot", undefined, "int256");
const verifyRes = await callQuery("reserveFeePercent", undefined, "uint256");
console.log(`  lnFeeRateRoot     = ${verifyLn.toString()}`);
console.log(`  reserveFeePercent = ${verifyRes.toString()}`);

const ok = verifyLn.toString() === newLnFeeRateRoot.toString() && verifyRes.toString() === newReserveFeePercent.toString();
console.log(ok ? "\n✓ Fee update confirmed." : "\n✗ MISMATCH — investigate.");

client.close();
process.exit(ok ? 0 : 4);
