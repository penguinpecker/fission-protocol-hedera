#!/usr/bin/env node
// Grants KEEPER_ROLE on SY_HBARX to the keeper address. Caller must hold
// DEFAULT_ADMIN_ROLE on the SY (set to syAdmin in the constructor).
//
// Usage:
//   node scripts/grant-keeper.mjs <sy-evm-address> <keeper-evm-address>

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

const [syEvm, keeperEvm] = process.argv.slice(2);
if (!syEvm?.startsWith("0x") || !keeperEvm?.startsWith("0x")) {
  console.error("Usage: node scripts/grant-keeper.mjs <sy-evm-address> <keeper-evm-address>");
  process.exit(1);
}

const KEEPER_ROLE = "0x" + Buffer.from(keccak_256("KEEPER_ROLE")).toString("hex");

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

const lookup = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${syEvm}`);
const syId = ContractId.fromString((await lookup.json()).contract_id);
console.log(`SY: ${syEvm}  →  ${syId.toString()}`);
console.log(`KEEPER_ROLE = ${KEEPER_ROLE}`);

console.log(`\n→ grantRole(KEEPER_ROLE, ${keeperEvm})…`);
const tx = new ContractExecuteTransaction()
  .setContractId(syId)
  .setGas(300_000)
  .setMaxTransactionFee(new Hbar(2))
  .setFunction(
    "grantRole",
    new ContractFunctionParameters().addBytes32(Buffer.from(KEEPER_ROLE.slice(2), "hex")).addAddress(keeperEvm)
  );
const submit = await tx.execute(client);
const receipt = await submit.getReceipt(client);
console.log(`  ${receipt.status.toString()}`);
client.close();
