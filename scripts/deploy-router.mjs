#!/usr/bin/env node
// Redeploy ActionRouter with maxAutomaticTokenAssociations=-1 (HIP-904).
// The original router at 0.0.10464662 was deployed with max_auto=0 and is
// admin-locked to itself — immutable, can't update. Any HTS transferFrom
// into it (e.g. SY shares before a swap) silently fails. Replace with a
// fresh deploy that auto-associates, then point the frontend at the new
// address.

import {
  Client,
  ContractCreateFlow,
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

const artifactPath = join(REPO, "contracts/out/ActionRouter.sol/ActionRouter.json");
const art = JSON.parse(readFileSync(artifactPath, "utf8"));
const bytecode = (art.bytecode?.object || art.bytecode || "").replace(/^0x/, "");

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
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr) {
  const evm = "0x" + operatorKey.publicKey.toEvmAddress();
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evm}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

console.log(`Deploying new ActionRouter with maxAutoAssoc=-1…`);
console.log(`  Operator:       ${operatorIdStr}`);
console.log(`  Bytecode size:  ${bytecode.length / 2}b`);

// Set the operator as admin so we can update auto-association later if Hedera
// changes the semantics. (Pre-handoff this is fine; post-handoff transfer to
// Timelock alongside the other contracts.)
const tx = await new ContractCreateFlow()
  .setBytecode(bytecode)
  .setGas(3_000_000)
  .setAdminKey(operatorKey.publicKey)
  .setMaxAutomaticTokenAssociations(-1)
  .execute(client);

const receipt = await tx.getReceipt(client);
const cid = receipt.contractId;
const evmAddr = "0x" + cid.num.toString(16).padStart(40, "0");

console.log(`\nDONE`);
console.log(`  Contract ID:  ${cid.toString()}`);
console.log(`  EVM:          ${evmAddr}`);
console.log(`  Tx:           ${tx.transactionId.toString()}`);

// Verify max_auto via Mirror Node (may need a few seconds to propagate).
await new Promise((r) => setTimeout(r, 4000));
const mi = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${cid.toString()}`).then((r) => r.json()).catch(() => null);
console.log(`  Mirror max_auto: ${mi?.max_automatic_token_associations}`);
console.log(`  Mirror admin:    ${mi?.admin_key ? "set" : "none"}`);

console.log(`\nNext:`);
console.log(`  1. Update Vercel: NEXT_PUBLIC_ROUTER_ADDRESS=${evmAddr}`);
console.log(`  2. Update deployments/295.json router.evm`);
console.log(`  3. Redeploy frontend.`);

client.close();
