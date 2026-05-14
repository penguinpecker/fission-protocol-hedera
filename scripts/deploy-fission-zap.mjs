#!/usr/bin/env node
// Deploy FissionZap on Hedera mainnet.
//
// Constructor: (address whbarContract, address whbarToken, address usdcToken, address swapRouter)
//
// All four addresses are well-known SaucerSwap V2 / WHBAR mainnet contracts;
// hardcoded below. No env override — this contract is a one-shot deploy.
//
// Usage:
//   node scripts/deploy-fission-zap.mjs
//
// The contract sets `maxAutomaticTokenAssociations = -1` (HIP-904) at deploy
// time so it can auto-associate with USDC and WHBAR HTS tokens when they
// hit the contract during the swap → deposit sequence.

import {
  Client,
  ContractCreateFlow,
  ContractFunctionParameters,
  PrivateKey,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

const WHBAR_CONTRACT = "0x0000000000000000000000000000000000163b59";
const WHBAR_TOKEN    = "0x0000000000000000000000000000000000163b5a";
const USDC_TOKEN     = "0x000000000000000000000000000000000006f89a";
const V3_SWAP_ROUTER = "0x00000000000000000000000000000000003c437a";

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

const artifactPath = join(REPO, "contracts/out/FissionZap.sol/FissionZap.json");
if (!existsSync(artifactPath)) {
  console.error(`artifact missing: ${artifactPath}`);
  console.error(`Run: cd contracts && forge build src/periphery/FissionZap.sol`);
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

console.log(`Deploying FissionZap…`);
console.log(`  Operator:        ${operatorIdStr}`);
console.log(`  WHBAR contract:  ${WHBAR_CONTRACT}`);
console.log(`  WHBAR token:     ${WHBAR_TOKEN}`);
console.log(`  USDC token:      ${USDC_TOKEN}`);
console.log(`  V3 swap router:  ${V3_SWAP_ROUTER}`);
console.log(`  Bytecode size:   ${bytecode.length / 2} bytes`);

if (process.env.DRY_RUN === "1") {
  console.log("\nDRY_RUN=1 — not broadcasting.");
  client.close();
  process.exit(0);
}

const params = new ContractFunctionParameters()
  .addAddress(WHBAR_CONTRACT)
  .addAddress(WHBAR_TOKEN)
  .addAddress(USDC_TOKEN)
  .addAddress(V3_SWAP_ROUTER);

const tx = await new ContractCreateFlow()
  .setBytecode(bytecode)
  .setConstructorParameters(params)
  .setGas(5_000_000)
  .setMaxAutomaticTokenAssociations(-1) // HIP-904 — auto-associate any HTS token
  .execute(client);

const receipt = await tx.getReceipt(client);
const cid = receipt.contractId;
const evmAddr = "0x" + cid.num.toString(16).padStart(40, "0");

console.log(`\nDONE`);
console.log(`  Contract ID:  ${cid.toString()}`);
console.log(`  EVM:          ${evmAddr}`);
console.log(`  Tx:           ${tx.transactionId.toString()}`);
console.log(`\nNext:`);
console.log(`  1. Add to deployments/295.json under \`fission_zap\`.`);
console.log(`  2. Set NEXT_PUBLIC_FISSION_ZAP_ADDRESS=${evmAddr} in Vercel env + frontend/.env.local`);
console.log(`  3. Redeploy frontend.`);

client.close();
