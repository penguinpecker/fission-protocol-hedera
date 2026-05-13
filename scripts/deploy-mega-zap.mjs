#!/usr/bin/env node
// Deploy FissionMegaZap on Hedera mainnet.
//
// Constructor: (address zap, address router)
//
// `zap` is the existing FissionZap (0x...009fd984).
// `router` is the freshly-deployed ActionRouterV3 — read from
// deployments/295.json (`router_v3.evm`). The MegaZap depends on v3 because
// addLiquidityProportional has to work for the LP path; v2's broken cast
// would block `zapHbarToLp`.
//
// Usage:
//   node scripts/deploy-mega-zap.mjs
//
// The contract is permissionless (no admin), so we deploy without an admin
// key. HIP-904 `max_auto_assoc=-1` set at deploy time so the MegaZap can
// receive SY shares + PT mid-tx.

import {
  Client,
  ContractCreateFlow,
  ContractFunctionParameters,
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

const artifactPath = join(REPO, "contracts/out/FissionMegaZap.sol/FissionMegaZap.json");
if (!existsSync(artifactPath)) {
  console.error(`artifact missing: ${artifactPath}`);
  console.error(`Run: cd contracts && forge build src/periphery/FissionMegaZap.sol`);
  process.exit(1);
}
const art = JSON.parse(readFileSync(artifactPath, "utf8"));
const bytecode = (art.bytecode?.object || art.bytecode || "").replace(/^0x/, "");

const deploymentsPath = join(REPO, "deployments/295.json");
const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));

const ZAP_ADDR = deployments.fission_zap?.evm;
if (!ZAP_ADDR) {
  console.error(`deployments/295.json missing fission_zap.evm`);
  process.exit(1);
}
// Prefer v3 router; fall back to v2 only if the user explicitly opts in (the
// MegaZap LP path will revert against v2 due to the addLiquidity bug, so this
// is just a safety net for testing the PT / YT paths in isolation).
const ROUTER_ADDR = deployments.router_v3?.evm
  ?? (process.env.ALLOW_V2_ROUTER === "1" ? deployments.router?.evm : null);
if (!ROUTER_ADDR) {
  console.error(`deployments/295.json missing router_v3.evm. Deploy ActionRouterV3 first:`);
  console.error(`  node scripts/deploy-router-v3.mjs`);
  process.exit(1);
}

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

console.log(`Deploying FissionMegaZap…`);
console.log(`  Operator:       ${operatorIdStr}`);
console.log(`  FissionZap:     ${ZAP_ADDR}`);
console.log(`  ActionRouter:   ${ROUTER_ADDR} ${deployments.router_v3?.evm === ROUTER_ADDR ? "(v3)" : "(v2 — LP path will revert)"}`);
console.log(`  Bytecode size:  ${bytecode.length / 2} bytes`);

if (process.env.DRY_RUN === "1") {
  console.log(`\nDRY_RUN=1 — not broadcasting.`);
  client.close();
  process.exit(0);
}

const params = new ContractFunctionParameters()
  .addAddress(ZAP_ADDR)
  .addAddress(ROUTER_ADDR);

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

// Verify max_auto.
await new Promise((r) => setTimeout(r, 4000));
const mi = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${cid.toString()}`).then((r) => r.json()).catch(() => null);
console.log(`  Mirror max_auto: ${mi?.max_automatic_token_associations}`);

// Persist to deployments/295.json.
deployments.mega_zap = {
  id: cid.toString(),
  evm: evmAddr,
  deployedAt: new Date().toISOString().slice(0, 10),
  tx: tx.transactionId.toString(),
  constructor: { zap: ZAP_ADDR, router: ROUTER_ADDR },
  notes:
    "Atomic HBAR → PT/YT/LP zap. Wraps FissionZap (HBAR→SY) and ActionRouterV3 " +
    "(SY→PT/YT/LP). Permissionless, no admin. maxAutomaticTokenAssociations=-1.",
};
writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
console.log(`  Wrote deployments/295.json → mega_zap.`);

console.log(`\nNext:`);
console.log(`  1. Verify on HashScan: node scripts/sourcify-verify.mjs FissionMegaZap.sol/FissionMegaZap.json ${evmAddr}`);
console.log(`  2. Set NEXT_PUBLIC_MEGA_ZAP_ADDRESS=${evmAddr} in Vercel env + frontend/.env.local`);
console.log(`  3. Redeploy frontend.`);

client.close();
