#!/usr/bin/env node
// Direct-RPC mainnet deploy. Bypasses forge script's local simulation
// (which reverts on Hedera HTS precompile calls — revm doesn't have 0x167).
// Deploys Factory + Router + SY_HBARX + SY_SaucerSwapV2LP, then proposes both
// SYs (starting the contract-enforced 7-day review window).
//
// Reads from .env (loaded directly):
//   SEED_PHRASE  → derive operator key (or HEDERA_OPERATOR_KEY direct)
//   HEDERA_MAINNET_RPC, HEDERA_NETWORK
//   FACTORY_ADMIN, MARKET_ADMIN, MARKET_TREASURY, SY_ADMIN, KEEPER_ADDRESS
//
// Writes deployments/295.json on success.

import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, encodeDeployData, parseEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

// ── env loader ──
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

// ── derive key ──
function deriveKey() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct : "0x" + direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!seed) throw new Error("Set SEED_PHRASE or HEDERA_OPERATOR_KEY in .env");
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  if (!child.privateKey) throw new Error(`derivation at ${path} failed`);
  return "0x" + Buffer.from(child.privateKey).toString("hex");
}

const PK = deriveKey();
const account = privateKeyToAccount(PK);
const RPC_URL = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";

const FACTORY_ADMIN   = getAddress(process.env.FACTORY_ADMIN   || account.address);
const MARKET_ADMIN    = getAddress(process.env.MARKET_ADMIN    || account.address);
const MARKET_TREASURY = getAddress(process.env.MARKET_TREASURY || account.address);
const SY_ADMIN        = getAddress(process.env.SY_ADMIN        || account.address);
const KEEPER          = getAddress(process.env.KEEPER_ADDRESS  || account.address);

// Hedera mainnet pinned addresses (lowercase — Hedera long-zero aliases aren't
// EIP-55 mixed-case checksummed; viem's getAddress would reject the mixed-case
// originals from MainnetAddresses.sol).
const HBARX  = getAddress("0x00000000000000000000000000000000000cba44");
const STADER = getAddress("0x0000000000000000000000000000000000158d97");
const NPM    = getAddress("0x00000000000000000000000000000000003ddbb9");
const USDC   = getAddress("0x000000000000000000000000000000000006f89a");
const WHBAR  = getAddress("0x0000000000000000000000000000000000163b5a");
const POOL_FEE = 1500;
const TICK_LOWER = -887220;
const TICK_UPPER = 887220;

// Sort token0 < token1 for V3 convention.
const T0 = USDC.toLowerCase() < WHBAR.toLowerCase() ? USDC : WHBAR;
const T1 = USDC.toLowerCase() < WHBAR.toLowerCase() ? WHBAR : USDC;

// ── load Foundry artifacts ──
function loadArtifact(path) {
  const json = JSON.parse(readFileSync(join(REPO, "contracts/out", path), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}
const factoryArt = loadArtifact("FissionFactory.sol/FissionFactory.json");
const routerArt = loadArtifact("ActionRouter.sol/ActionRouter.json");
const syHbarxArt = loadArtifact("SY_HBARX.sol/SY_HBARX.json");
const sySaucerArt = loadArtifact("SY_SaucerSwapV2LP.sol/SY_SaucerSwapV2LP.json");

// ── clients ──
const chain = {
  id: 295,
  name: "Hedera Mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

console.log(`\n──────────────────────────────────────────────`);
console.log(`  Fission Mainnet Deploy (direct-RPC, no forge sim)`);
console.log(`──────────────────────────────────────────────`);
console.log(`  deployer       : ${account.address}`);
console.log(`  factoryAdmin   : ${FACTORY_ADMIN}`);
console.log(`  marketAdmin    : ${MARKET_ADMIN}`);
console.log(`  marketTreasury : ${MARKET_TREASURY}`);
console.log(`  syAdmin        : ${SY_ADMIN}`);
console.log(`  keeper         : ${KEEPER}`);
console.log(`  RPC            : ${RPC_URL}`);

const balance = await publicClient.getBalance({ address: account.address });
console.log(`  balance        : ${(Number(balance) / 1e18).toFixed(4)} HBAR`);
if (balance < parseEther("6")) {
  throw new Error("Insufficient balance: need at least 6 HBAR for Router + 2 SY adapters via Hashio (Factory deploys via SDK separately).");
}

// Hashio mainnet min gas price: 960 gwei. Bumping to 1100 gwei to clear any
// rounding margin when the floor moves between blocks.
const GAS_PRICE = 1_100_000_000_000n; // 1100 gwei

async function deployContract({ name, abi, bytecode, args, value = 0n, gas = 15_000_000n }) {
  const data = encodeDeployData({ abi, bytecode, args });
  console.log(`\n→ Deploying ${name}…`);
  const hash = await walletClient.sendTransaction({
    data,
    value,
    gas,
    gasPrice: GAS_PRICE,
  });
  console.log(`  tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${name} deploy reverted (status=${receipt.status})`);
  console.log(`  ✓ ${name} @ ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

// FissionFactory is 71KB — too big for Hashio's 15M-gas-per-tx cap. Use the
// Hedera SDK's FileService path (scripts/deploy-mainnet-sdk.mjs) for that one.
// Router and SY adapters fit in 15M gas, deploy fine via Hashio (which DOES
// pass tx-value through to the constructor as msg.value, unlike SDK
// setInitialBalance).

let routerAddr = process.env.ROUTER_ADDRESS;
if (routerAddr) {
  console.log(`\n→ Reusing existing ActionRouter @ ${routerAddr}`);
} else {
  // ── Router ──
  routerAddr = await deployContract({
    name: "ActionRouter",
    abi: routerArt.abi,
    bytecode: routerArt.bytecode,
    args: [],
  });
}

// SY_HBARX two-step: deploy (cheap, no precompile), then initShareToken with HBAR.
let syHbarxAddr = process.env.SY_HBARX_ADDRESS;
if (syHbarxAddr) {
  console.log(`\n→ Reusing existing SY_HBARX @ ${syHbarxAddr}`);
} else {
  syHbarxAddr = await deployContract({
    name: "SY_HBARX",
    abi: syHbarxArt.abi,
    bytecode: syHbarxArt.bytecode,
    args: [HBARX, STADER, SY_ADMIN, 0],
    gas: 8_000_000n,
  });
  console.log(`  ⚠  Deploy succeeded — initShareToken NOT yet called.`);
  console.log(`     Run: node scripts/init-sy.mjs ${syHbarxAddr} 15`);
}

// SY_SaucerSwapV2LP two-step: deploy here, init via SDK (init-sy.mjs).
// Hashio-relayed EthereumTransaction can't fund the precompile child
// TOKENCREATION's max_fee — we proved that on SY_HBARX. The SDK
// ContractExecuteTransaction with setPayableAmount(15 HBAR) works.
let sySaucerAddr = process.env.SY_SAUCER_V2_LP_ADDRESS;
if (sySaucerAddr) {
  console.log(`\n→ Reusing existing SY_SaucerSwapV2LP @ ${sySaucerAddr}`);
} else {
  sySaucerAddr = await deployContract({
    name: "SY_SaucerSwapV2LP",
    abi: sySaucerArt.abi,
    bytecode: sySaucerArt.bytecode,
    args: ["Fission SY-SaucerV2LP", "fSY-SS-V2", T0, T1, POOL_FEE, TICK_LOWER, TICK_UPPER, NPM, SY_ADMIN, 0],
    gas: 12_000_000n,
  });
  console.log(`  ⚠  Deploy succeeded — initShareToken NOT yet called.`);
  console.log(`     Run: node scripts/init-sy.mjs ${sySaucerAddr} 15`);
}

// proposeSY skipped here — run it AFTER deploying Factory via SDK:
//   FACTORY_ADDRESS=0x... node scripts/post-deploy-propose.mjs

// ── Persist partial deployment ──
const deployDir = join(REPO, "deployments");
mkdirSync(deployDir, { recursive: true });
const outPath = join(deployDir, "295-partial.json");
const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const out = {
  chainId: 295,
  network: "mainnet",
  deployedAt: new Date().toISOString(),
  ...existing,
  router: routerAddr,
  sy_hbarx: syHbarxAddr,
  sy_saucer_v2_lp: sySaucerAddr,
  deployer: account.address,
  factoryAdmin: FACTORY_ADMIN,
  marketAdmin: MARKET_ADMIN,
  marketTreasury: MARKET_TREASURY,
  syAdmin: SY_ADMIN,
  keeper: KEEPER,
  notes: "Factory not yet deployed — run scripts/deploy-mainnet-sdk.mjs (uses Hedera SDK FileService for the 71KB Factory bytecode that exceeds Hashio's 15M-gas cap).",
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

console.log(`\n──────────────────────────────────────────────`);
console.log(`  ✅ Router + SY adapters deployed — wrote ${outPath}`);
console.log(`──────────────────────────────────────────────`);
console.log(`  Router           : ${routerAddr}`);
console.log(`  SY_HBARX         : ${syHbarxAddr}`);
console.log(`  SY_SaucerSwapV2LP: ${sySaucerAddr}`);
console.log(`──────────────────────────────────────────────`);
console.log(`\n  NEXT: deploy the Factory via Hedera SDK:`);
console.log(`    node scripts/deploy-mainnet-sdk.mjs   # Factory only`);
console.log(`  Then proposeSY for both SYs, wait 7 days, createMarket each.`);
