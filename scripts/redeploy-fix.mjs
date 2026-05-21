#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  redeploy-fix.mjs — deploys the Ed25519-fixed market machinery alongside
//  the existing system. Preserves existing SY adapter (and the $700+ V3 NFT
//  it holds), preserves existing operator positions on the old market.
// ════════════════════════════════════════════════════════════════════════════
//
//  Deploys:
//    1. StandardMarketDeployer (new bytecode — bakes in fixed FissionMarket)
//    2. RewardsMarketDeployer  (new bytecode — bakes in fixed FissionMarketRewards)
//    3. FissionFactory         (points at new deployers; reuses existing SY)
//
//  Reuses (NOT touched):
//    - SY_HBARX           (0x...0c bA44 wrapped, no Ed25519 bug there)
//    - SY_SaucerSwapV2LP  (V3 NFT lives inside — preserves the $700 value)
//    - ActionRouter v3    (no contract changes affect router)
//    - FissionZap         (no contract changes)
//    - MegaZap            (no contract changes)
//
//  Updates deployments/295.json by MERGING (does NOT overwrite). Old factory
//  and market are moved into `abandoned`.

import {
  Client, ContractCreateFlow, ContractCreateTransaction, ContractFunctionParameters,
  FileAppendTransaction, FileCreateTransaction, Hbar, PrivateKey,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
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

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = ("0x" + operatorKey.publicKey.toEvmAddress()).toLowerCase();

let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const res = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await res.json()).account;
}

const FACTORY_ADMIN   = (process.env.FACTORY_ADMIN   || evmAddr).toLowerCase();
const MARKET_ADMIN    = (process.env.MARKET_ADMIN    || evmAddr).toLowerCase();
const MARKET_TREASURY = (process.env.MARKET_TREASURY || evmAddr).toLowerCase();
const SY_REVIEW_WINDOW = (process.env.SY_REVIEW_WINDOW ?? "0").toString();

console.log("=".repeat(70));
console.log(`Operator:        ${operatorIdStr}  ${evmAddr}`);
console.log(`Factory admin:   ${FACTORY_ADMIN}`);
console.log(`Market admin:    ${MARKET_ADMIN}`);
console.log(`Market treasury: ${MARKET_TREASURY}`);
console.log(`SY review window: ${SY_REVIEW_WINDOW}s  (0 = bootstrap, 604800 = 7d production)`);
console.log("=".repeat(70));

const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(20));
client.setDefaultMaxQueryPayment(new Hbar(2));

// ── bytecode loaders ───────────────────────────────────────────────────────
function readBytecode(rel) {
  const p = join(REPO, "contracts", "out", rel);
  const art = JSON.parse(readFileSync(p, "utf8"));
  // Strip 0x prefix, the SDK wants raw hex.
  return Buffer.from(art.bytecode.object.replace(/^0x/, ""), "hex");
}

const standardDeployerBytes = readBytecode("StandardMarketDeployer.sol/StandardMarketDeployer.json");
const rewardsDeployerBytes  = readBytecode("RewardsMarketDeployer.sol/RewardsMarketDeployer.json");
const factoryBytes          = readBytecode("FissionFactory.sol/FissionFactory.json");

console.log(`\nBytecode sizes:`);
console.log(`  StandardDeployer: ${standardDeployerBytes.length} bytes`);
console.log(`  RewardsDeployer:  ${rewardsDeployerBytes.length} bytes`);
console.log(`  Factory:          ${factoryBytes.length} bytes`);

async function deploy({ name, bytecode, params, gas }) {
  console.log(`\n→ Deploying ${name}…`);
  // For small (<~28KB hex), ContractCreateFlow works.
  // For larger, manual FileCreate + FileAppend + ContractCreate path.
  const hexLen = bytecode.length * 2;
  if (hexLen < 28000) {
    const tx = new ContractCreateFlow()
      .setBytecode(bytecode)
      .setGas(gas)
      .setMaxAutomaticTokenAssociations(-1)
      .setAdminKey(operatorKey.publicKey);
    if (params) tx.setConstructorParameters(params);
    const resp = await tx.execute(client);
    const r = await resp.getReceipt(client);
    const contractId = r.contractId.toString();
    const num = Number(contractId.split(".").pop());
    const ev = "0x" + num.toString(16).padStart(40, "0");
    console.log(`  ✓ ${name} → ${contractId}  ${ev}`);
    return { contractId, evmAddress: ev };
  }
  // Manual path for large bytecode.
  const hexStr = bytecode.toString("hex");
  const CHUNK = 4000; // hex chars
  const head = Buffer.from(hexStr.slice(0, CHUNK), "hex");
  const fc = await new FileCreateTransaction()
    .setContents(head)
    .setKeys([operatorKey.publicKey])
    .setMaxTransactionFee(new Hbar(5))
    .execute(client);
  const fileId = (await fc.getReceipt(client)).fileId;
  console.log(`  uploaded head → ${fileId}`);

  for (let i = CHUNK; i < hexStr.length; i += CHUNK) {
    const chunk = Buffer.from(hexStr.slice(i, i + CHUNK), "hex");
    await (await new FileAppendTransaction()
      .setFileId(fileId)
      .setContents(chunk)
      .setMaxChunks(20)
      .setMaxTransactionFee(new Hbar(5))
      .execute(client)).getReceipt(client);
  }
  console.log(`  uploaded full bytecode`);

  const cc = new ContractCreateTransaction()
    .setBytecodeFileId(fileId)
    .setGas(gas)
    .setMaxAutomaticTokenAssociations(-1)
    .setAdminKey(operatorKey.publicKey);
  if (params) cc.setConstructorParameters(params);
  const ccResp = await cc.execute(client);
  const r = await ccResp.getReceipt(client);
  const contractId = r.contractId.toString();
  const num = Number(contractId.split(".").pop());
  const ev = "0x" + num.toString(16).padStart(40, "0");
  console.log(`  ✓ ${name} → ${contractId}  ${ev}`);
  return { contractId, evmAddress: ev };
}

// ─── deploy sequence ───────────────────────────────────────────────────────
const standardDeployer = await deploy({
  name: "StandardMarketDeployer",
  bytecode: standardDeployerBytes,
  gas: 12_000_000,
});

const rewardsDeployer = await deploy({
  name: "RewardsMarketDeployer",
  bytecode: rewardsDeployerBytes,
  gas: 12_000_000,
});

const factory = await deploy({
  name: "FissionFactory",
  bytecode: factoryBytes,
  params: new ContractFunctionParameters()
    .addAddress(FACTORY_ADMIN.slice(2))
    .addAddress(MARKET_ADMIN.slice(2))
    .addAddress(MARKET_TREASURY.slice(2))
    .addAddress(standardDeployer.evmAddress.slice(2))
    .addAddress(rewardsDeployer.evmAddress.slice(2))
    .addUint256(SY_REVIEW_WINDOW),
  gas: 8_000_000,
});

// ─── merge into deployments/295.json (carefully) ───────────────────────────
const deploymentsPath = join(REPO, "deployments", "295.json");
const existing = JSON.parse(readFileSync(deploymentsPath, "utf8"));

// Move old factory + old deployers + old market into abandoned.
existing.abandoned ??= {};
existing.abandoned.old_factories ??= [];
existing.abandoned.old_deployers ??= [];
existing.abandoned.old_markets ??= [];

if (existing.factory?.evm && !existing.abandoned.old_factories.includes(existing.factory.evm)) {
  existing.abandoned.old_factories.push(existing.factory.evm);
}
if (existing.standard_deployer?.evm && !existing.abandoned.old_deployers.includes(existing.standard_deployer.evm)) {
  existing.abandoned.old_deployers.push(existing.standard_deployer.evm);
}
if (existing.rewards_deployer?.evm && !existing.abandoned.old_deployers.includes(existing.rewards_deployer.evm)) {
  existing.abandoned.old_deployers.push(existing.rewards_deployer.evm);
}
for (const m of existing.markets ?? []) {
  if (m.evm && !existing.abandoned.old_markets.includes(m.evm)) {
    existing.abandoned.old_markets.push(m.evm);
  }
}
existing.abandoned.reason_2026_05_22 =
  "Ed25519 reward-accrual bug fix — see audits/internal/SECURITY_REVIEW_ED25519_BAL_2026-05-22.md. " +
  "Old contracts remain live; operator's existing LP/PT/YT positions are fully withdrawable on-chain.";

// Apply new addresses.
existing.factory = { id: factory.contractId, evm: factory.evmAddress };
existing.standard_deployer = { id: standardDeployer.contractId, evm: standardDeployer.evmAddress };
existing.rewards_deployer  = { id: rewardsDeployer.contractId,  evm: rewardsDeployer.evmAddress };
existing.factoryAdmin = FACTORY_ADMIN;
existing.marketAdmin = MARKET_ADMIN;
existing.marketTreasury = MARKET_TREASURY;
existing.sy_review_window_seconds = Number(SY_REVIEW_WINDOW);
existing.markets = []; // fresh — new market will be created next via createRewardsMarket script
existing.deployedAt = new Date().toISOString();
existing.notes = "Ed25519-fixed redeploy 2026-05-22. New factory + deployers; SY adapter reused (V3 NFT untouched). " +
                 "Old factory/deployers/market moved to abandoned. Operator positions on old market remain withdrawable.";

writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
console.log(`\nUpdated ${deploymentsPath}`);
console.log("\n=== Summary ===");
console.log(`Factory:            ${factory.contractId}  ${factory.evmAddress}`);
console.log(`StandardDeployer:   ${standardDeployer.contractId}  ${standardDeployer.evmAddress}`);
console.log(`RewardsDeployer:    ${rewardsDeployer.contractId}  ${rewardsDeployer.evmAddress}`);
console.log();
console.log("Next steps:");
console.log("  1. node scripts/propose-sy.mjs   (proposeSY on new factory for SY_SaucerSwapV2LP)");
console.log("  2. node scripts/confirm-sy.mjs   (window=0 → instant)");
console.log("  3. node scripts/create-markets.mjs  (createRewardsMarket → mints new PT/YT/LP HTS tokens)");
console.log("  4. Mint SY shares + initialize the new market");
console.log("  5. Update Vercel NEXT_PUBLIC_FACTORY_ADDRESS, redeploy, refresh markets_cache");
console.log("  6. Verify on HashScan via sourcify-verify.mjs");

client.close();
