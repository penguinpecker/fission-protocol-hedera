#!/usr/bin/env node
// Deploy ActionRouterV3 on Hedera mainnet.
//
// v3 fixes the `addLiquidityProportional` typing bug in v2 — it now pulls
// `sy.shareToken()` instead of casting the SY *contract* address as IERC20.
// Every other entry is byte-for-byte identical to v2; same ABI, same admin
// model, same HIP-904 `max_auto_assoc=-1`.
//
// Usage:
//   node scripts/deploy-router-v3.mjs
//
// After deploy, the script:
//   - Sets maxAutomaticTokenAssociations=-1 (HIP-904)
//   - Writes the EVM + Hedera ID to deployments/295.json under `router_v3`
//   - Prints next-step instructions for verification + frontend wiring

import {
  Client,
  ContractCreateFlow,
  PrivateKey,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

const artifactPath = join(REPO, "contracts/out/ActionRouterV3.sol/ActionRouterV3.json");
if (!existsSync(artifactPath)) {
  console.error(`artifact missing: ${artifactPath}`);
  console.error(`Run: cd contracts && forge build src/periphery/ActionRouterV3.sol`);
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
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evm}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

console.log(`Deploying ActionRouterV3…`);
console.log(`  Operator:       ${operatorIdStr}`);
console.log(`  Bytecode size:  ${bytecode.length / 2}b`);

if (process.env.DRY_RUN === "1") {
  console.log(`\nDRY_RUN=1 — not broadcasting.`);
  client.close();
  process.exit(0);
}

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

// Verify max_auto via Mirror Node.
await new Promise((r) => setTimeout(r, 4000));
const mi = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${cid.toString()}`).then((r) => r.json()).catch(() => null);
console.log(`  Mirror max_auto: ${mi?.max_automatic_token_associations}`);
console.log(`  Mirror admin:    ${mi?.admin_key ? "set" : "none"}`);

// Persist to deployments/295.json under `router_v3`. Leave the existing
// `router` field alone — the frontend env update is what flips production
// over to v3.
const deploymentsPath = join(REPO, "deployments/295.json");
const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));
deployments.router_v3 = {
  id: cid.toString(),
  evm: evmAddr,
  deployedAt: new Date().toISOString().slice(0, 10),
  tx: tx.transactionId.toString(),
  notes:
    "ActionRouter v3 — fixes addLiquidityProportional typing bug from v2 " +
    "(now pulls sy.shareToken() instead of the SY contract address). " +
    "maxAutomaticTokenAssociations=-1, operator-admin. Drop-in ABI-compatible " +
    "with v2 (0.0.10475923) for the other entries.",
};
writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
console.log(`  Wrote deployments/295.json → router_v3.`);

console.log(`\nNext:`);
console.log(`  1. Verify on HashScan: node scripts/sourcify-verify.mjs ActionRouterV3.sol/ActionRouterV3.json ${evmAddr}`);
console.log(`  2. Set NEXT_PUBLIC_ROUTER_ADDRESS=${evmAddr} in Vercel env + frontend/.env.local`);
console.log(`  3. Redeploy frontend.`);

client.close();
