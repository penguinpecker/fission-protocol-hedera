#!/usr/bin/env node
// Deploy OZ TimelockController, configured for Hedera 2-of-2 threshold-account
// governance. The threshold account holds PROPOSER_ROLE + EXECUTOR_ROLE; admin
// is renounced (address(0)) so the Timelock self-governs after deploy.
//
// Constructor: (uint256 minDelay, address[] proposers, address[] executors, address admin)
//
// Usage:
//   PROD_THRESHOLD_EVM=0x... node scripts/deploy-timelock.mjs [minDelaySeconds=172800]
//
// minDelay defaults to 172800 (48h). Pass 0 if you want to do the first
// admin handoff without delay then raise to 48h later via
// `timelock.updateDelay(172800)` (called via schedule+execute by the
// threshold account).
//
// Deploy path: Hashio (Timelock bytecode is well under 15M gas).

import {
  Client,
  ContractCreateFlow,
  ContractFunctionParameters,
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

const threshold = (process.env.PROD_THRESHOLD_EVM || "").trim();
const minDelay = Number(process.argv[2] ?? "172800");
if (!/^0x[0-9a-fA-F]{40}$/.test(threshold)) {
  console.error("Set PROD_THRESHOLD_EVM=0x... (the threshold account's EVM alias)");
  process.exit(1);
}

const artifactPath = join(REPO, "contracts/out/Timelock.sol/Timelock.json");
if (!existsSync(artifactPath)) {
  console.error(`artifact missing: ${artifactPath}`);
  console.error(`Run: cd contracts && forge build  (a Timelock.sol shim must exist; see contracts/src/governance/Timelock.sol)`);
  process.exit(1);
}
const art = JSON.parse(readFileSync(artifactPath, "utf8"));
const bytecode = (art.bytecode?.object || art.bytecode || "").replace(/^0x/, "");

function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!seed) throw new Error("Set SEED_PHRASE or HEDERA_OPERATOR_KEY");
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());

let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr) {
  const evm = "0x" + operatorKey.publicKey.toEvmAddress();
  const res = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evm}`);
  operatorIdStr = (await res.json()).account;
}

const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

console.log(`Deploying Timelock…`);
console.log(`  minDelay:  ${minDelay}s (${(minDelay/3600).toFixed(1)}h)`);
console.log(`  proposer:  ${threshold}`);
console.log(`  executor:  ${threshold}`);
console.log(`  admin:     0x0000000000000000000000000000000000000000 (renounced)`);

const params = new ContractFunctionParameters()
  .addUint256(minDelay)
  .addAddressArray([threshold])
  .addAddressArray([threshold])
  .addAddress("0x0000000000000000000000000000000000000000");

const tx = await new ContractCreateFlow()
  .setBytecode(bytecode)
  .setConstructorParameters(params)
  .setGas(5_000_000)
  .setMaxAutomaticTokenAssociations(-1)
  .execute(client);

const receipt = await tx.getReceipt(client);
const cid = receipt.contractId;
const evmAddr = "0x" + cid.num.toString(16).padStart(40, "0");

console.log(`\nDONE`);
console.log(`  Contract ID:  ${cid.toString()}`);
console.log(`  EVM:          ${evmAddr}`);
console.log(`  Tx:           ${tx.transactionId.toString()}`);
console.log(`\nNext: add to deployments/295.json under \`governance.timelock\`.`);

client.close();
