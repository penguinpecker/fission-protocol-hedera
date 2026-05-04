#!/usr/bin/env node
// Fund the SY contract with HBAR (so auto-renew prefunding can pull from
// contract balance), then call initShareToken.

import {
  Client,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  PrivateKey,
  TransferTransaction,
  AccountId,
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

const syArg = process.argv[2];
const fundAmount = Number(process.argv[3] ?? "30"); // 30 HBAR funding
const initAmount = Number(process.argv[4] ?? "0");  // msg.value at init

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

// Resolve EVM address → Hedera contract id via Mirror Node.
const lookup = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${syArg}`);
const lookupData = await lookup.json();
const contractIdStr = lookupData.contract_id;
if (!contractIdStr) throw new Error(`No Hedera contract found at ${syArg}`);
const contractId = ContractId.fromString(contractIdStr);
console.log(`SY: ${syArg}  →  ${contractId.toString()}`);

// Step 1: fund the contract via TransferTransaction.
console.log(`\n→ Funding ${contractId.toString()} with ${fundAmount} HBAR…`);
const fundTx = new TransferTransaction()
  .addHbarTransfer(AccountId.fromString(operatorIdStr), new Hbar(-fundAmount))
  .addHbarTransfer(AccountId.fromString(contractIdStr), new Hbar(fundAmount))
  .setMaxTransactionFee(new Hbar(2));
const fundSubmit = await fundTx.execute(client);
const fundReceipt = await fundSubmit.getReceipt(client);
console.log(`  funded: ${fundReceipt.status.toString()}`);

// Sanity check: contract balance.
const balRes = await fetch("https://mainnet.hashio.io/api", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [syArg, "latest"] }),
}).then(r => r.json());
console.log(`  contract balance now: ${(parseInt(balRes.result, 16) / 1e18).toFixed(4)} HBAR`);

// Step 2: call initShareToken with whatever payable amount.
console.log(`\n→ Calling initShareToken with msg.value = ${initAmount} HBAR…`);
const initTx = new ContractExecuteTransaction()
  .setContractId(contractId)
  .setGas(15_000_000)
  .setMaxTransactionFee(new Hbar(50))
  .setPayableAmount(new Hbar(initAmount))
  .setFunction("initShareToken");
const initSubmit = await initTx.execute(client);
const initReceipt = await initSubmit.getReceipt(client);
console.log(`  receipt: ${initReceipt.status.toString()}`);

if (initReceipt.status.toString() === "SUCCESS") {
  console.log(`  ✓ initShareToken succeeded`);
} else {
  process.exit(1);
}
client.close();
