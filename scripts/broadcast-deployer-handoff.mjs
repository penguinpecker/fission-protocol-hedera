#!/usr/bin/env node
// Broadcast the deployer-side admin-transfer txs from deployments/handoff/deployer-side.json.
// One ContractExecuteTransaction per call, signed by the operator EOA.

import {
  Client,
  ContractExecuteTransaction,
  ContractId,
  PrivateKey,
  Hbar,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const operatorId = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorId) throw new Error("Set HEDERA_OPERATOR_ID");

const client = Client.forMainnet().setOperator(operatorId, operatorKey);

const handoff = JSON.parse(readFileSync(join(REPO, "deployments/handoff/deployer-side.json"), "utf8"));

console.log(`Broadcasting ${handoff.calls.length} deployer-side admin-transfer txs from ${operatorId}…\n`);

const results = [];
for (const call of handoff.calls) {
  const evmAddr = call.to.toLowerCase().replace(/^0x/, "");
  const contractId = ContractId.fromEvmAddress(0, 0, evmAddr);
  const calldata = Buffer.from(call.data.replace(/^0x/, ""), "hex");

  console.log(`  → ${call.contract} (${call.to})`);
  const tx = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(200_000)
    .setFunctionParameters(calldata)
    .setMaxTransactionFee(new Hbar(2))
    .freezeWith(client);

  const signed = await tx.sign(operatorKey);
  const submit = await signed.execute(client);
  const receipt = await submit.getReceipt(client);
  console.log(`     status: ${receipt.status.toString()}   tx: ${submit.transactionId.toString()}\n`);
  results.push({ contract: call.contract, to: call.to, status: receipt.status.toString(), tx: submit.transactionId.toString() });
}

console.log("DONE");
console.log(JSON.stringify(results, null, 2));

client.close();
