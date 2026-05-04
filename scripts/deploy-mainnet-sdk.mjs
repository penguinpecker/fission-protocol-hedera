#!/usr/bin/env node
// Hedera-SDK-based mainnet deploy. Uses ContractCreateFlow which auto-uploads
// bytecode via FileService when the contract exceeds the JSON-RPC 15M-gas cap
// (FissionFactory is 71KB runtime — JSON-RPC can't deploy it). Bypasses
// Hashio entirely for the Factory deploy.
//
// Reads .env directly (loaded inline, handles seeds with apostrophes/spaces).
//
// Output: deployments/295.json with all deployed addresses.

import {
  Client,
  ContractCreateFlow,
  ContractCreateTransaction,
  ContractFunctionParameters,
  FileAppendTransaction,
  FileCreateTransaction,
  Hbar,
  PrivateKey,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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
  if (!seed) throw new Error("Set SEED_PHRASE or HEDERA_OPERATOR_KEY in .env");
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  if (!child.privateKey) throw new Error(`derivation at ${path} failed`);
  return Buffer.from(child.privateKey).toString("hex");
}

const keyHex = deriveKeyHex();
const operatorKey = PrivateKey.fromStringECDSA(keyHex);
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();

// Resolve operator account ID from EVM address via Mirror Node if .env still has
// the placeholder. Once user fills it in, this skips the lookup.
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  console.log(`HEDERA_OPERATOR_ID not set — looking up via Mirror Node…`);
  const res = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  if (!res.ok) throw new Error(`Mirror Node lookup failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.account) throw new Error(`No Hedera account found for EVM ${evmAddr} — fund it first`);
  operatorIdStr = data.account;
  console.log(`  resolved: ${operatorIdStr}`);
}

const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(20));
client.setDefaultMaxQueryPayment(new Hbar(2));

const FACTORY_ADMIN   = (process.env.FACTORY_ADMIN   || evmAddr).toLowerCase();
const MARKET_ADMIN    = (process.env.MARKET_ADMIN    || evmAddr).toLowerCase();
const MARKET_TREASURY = (process.env.MARKET_TREASURY || evmAddr).toLowerCase();
const SY_ADMIN        = (process.env.SY_ADMIN        || evmAddr).toLowerCase();
const KEEPER          = (process.env.KEEPER_ADDRESS  || evmAddr).toLowerCase();

// Hedera mainnet pinned addresses.
const HBARX  = "0x00000000000000000000000000000000000cbA44".toLowerCase();
const STADER = "0x0000000000000000000000000000000000158d97".toLowerCase();
const NPM    = "0x00000000000000000000000000000000003DDbb9".toLowerCase();
const USDC   = "0x000000000000000000000000000000000006f89a".toLowerCase();
const WHBAR  = "0x0000000000000000000000000000000000163B5a".toLowerCase();
const POOL_FEE = 1500;
const TICK_LOWER = -887220;
const TICK_UPPER = 887220;

const T0 = USDC < WHBAR ? USDC : WHBAR;
const T1 = USDC < WHBAR ? WHBAR : USDC;

// Hedera FileService stores the bytecode as HEX-ENCODED TEXT (the same string
// you'd see in the Foundry artifact, minus 0x). Hedera Services decodes the
// hex when ContractCreate references the file. Passing raw bytes makes Hedera
// try to interpret binary as hex → ERROR_DECODING_BYTESTRING.
function readBytecode(path) {
  const json = JSON.parse(readFileSync(join(REPO, "contracts/out", path), "utf8"));
  let hex = json.bytecode.object;
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length % 2 !== 0) throw new Error(`bytecode length odd: ${path}`);
  // Return the hex characters as a UTF-8 byte sequence (so the file contents
  // are the literal hex text). The SDK's setBytecode will pass this through.
  return new TextEncoder().encode(hex);
}

const factoryBytes  = readBytecode("FissionFactory.sol/FissionFactory.json");
const routerBytes   = readBytecode("ActionRouter.sol/ActionRouter.json");
const syHbarxBytes  = readBytecode("SY_HBARX.sol/SY_HBARX.json");
const sySaucerBytes = readBytecode("SY_SaucerSwapV2LP.sol/SY_SaucerSwapV2LP.json");
const standardDeployerBytes = readBytecode("StandardMarketDeployer.sol/StandardMarketDeployer.json");
const rewardsDeployerBytes  = readBytecode("RewardsMarketDeployer.sol/RewardsMarketDeployer.json");

console.log(`\n──────────────────────────────────────────────`);
console.log(`  Fission Mainnet Deploy (Hedera SDK / FileService)`);
console.log(`──────────────────────────────────────────────`);
console.log(`  operator (0.0.) : ${operatorIdStr}`);
console.log(`  operator (EVM)  : ${evmAddr}`);
console.log(`  factoryAdmin    : ${FACTORY_ADMIN}`);
console.log(`  marketAdmin     : ${MARKET_ADMIN}`);
console.log(`  marketTreasury  : ${MARKET_TREASURY}`);
console.log(`  syAdmin         : ${SY_ADMIN}`);
console.log(`  keeper          : ${KEEPER}`);
console.log(`  bytecode sizes  : factory=${factoryBytes.length}b, router=${routerBytes.length}b, syHbarx=${syHbarxBytes.length}b, sySaucer=${sySaucerBytes.length}b`);

async function deploy({ name, bytecode, params, gas = 12_000_000, payableHbar = 0 }) {
  console.log(`\n→ Deploying ${name} (bytecode ${bytecode.length}b, gas ${gas}, value ${payableHbar} HBAR)…`);

  // For small contracts (< ~28KB hex text, fits in one FileCreate), use ContractCreateFlow.
  // For larger ones, do FileCreate + FileAppend (with explicit maxChunks) + ContractCreate
  // manually — the SDK's ContractCreateFlow.execute path doesn't respect setMaxChunks
  // (a known quirk: only executeWithSigner applies it).
  if (bytecode.length <= 28000) {
    const tx = new ContractCreateFlow()
      .setBytecode(bytecode)
      .setGas(gas);
    if (params) tx.setConstructorParameters(params);
    if (payableHbar > 0) tx.setInitialBalance(new Hbar(payableHbar));
    const submit = await tx.execute(client);
    const receipt = await submit.getReceipt(client);
    const id = receipt.contractId;
    const num = id.num.toNumber();
    const evm = "0x" + num.toString(16).padStart(40, "0");
    console.log(`  ✓ ${name}  ${id.toString()}  (${evm})`);
    return { contractId: id.toString(), evmAddress: evm };
  }

  // Manual flow for big bytecode (> 28KB hex text).
  console.log(`  · Bytecode > 28KB — using manual FileCreate + FileAppend.`);
  const initialChunk = bytecode.subarray(0, 2048);
  const remainder = bytecode.subarray(2048);

  const fc = new FileCreateTransaction()
    .setKeys([operatorKey.publicKey])
    .setContents(initialChunk)
    .setMaxTransactionFee(new Hbar(5));
  const fcSubmit = await fc.execute(client);
  const fcReceipt = await fcSubmit.getReceipt(client);
  const fileId = fcReceipt.fileId;
  console.log(`  · FileCreate  → ${fileId.toString()} (initial 2048b)`);

  // Append the remainder in batches. Each batch is its own FileAppend transaction
  // — splitting up the work means a slow node on one chunk doesn't expire the whole
  // upload. Each FileAppend SDK call internally chunks at ~4KB; we keep each
  // outer call to ≤8 chunks (~32KB) to stay well under the 180s validDuration cap.
  const BATCH_BYTES = 32 * 1024; // 8 chunks at 4KB each
  for (let off = 0; off < remainder.length; off += BATCH_BYTES) {
    const batch = remainder.subarray(off, Math.min(off + BATCH_BYTES, remainder.length));
    let attempt = 0;
    while (true) {
      try {
        const fa = new FileAppendTransaction()
          .setFileId(fileId)
          .setContents(batch)
          .setMaxChunks(20)
          .setMaxTransactionFee(new Hbar(20));
        await fa.execute(client);
        console.log(`  · FileAppend  → +${batch.length}b @ offset ${off}`);
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 3 || !String(e).includes("TRANSACTION_EXPIRED")) throw e;
        console.log(`  · retry append @ offset ${off} (attempt ${attempt}, ${e.status?._code ?? "?"})`);
      }
    }
  }

  const cc = new ContractCreateTransaction()
    .setBytecodeFileId(fileId)
    .setGas(gas)
    .setMaxTransactionFee(new Hbar(50));
  if (params) cc.setConstructorParameters(params);
  if (payableHbar > 0) cc.setInitialBalance(new Hbar(payableHbar));
  const ccSubmit = await cc.execute(client);
  const ccReceipt = await ccSubmit.getReceipt(client);
  const id = ccReceipt.contractId;
  const num = id.num.toNumber();
  const evm = "0x" + num.toString(16).padStart(40, "0");
  console.log(`  ✓ ${name}  ${id.toString()}  (${evm})`);
  return { contractId: id.toString(), evmAddress: evm };
}

// Deploy in size order: smallest first (verifies the SDK path), then progressively
// bigger. The 71KB FissionFactory is the only one that exceeds Hashio's JSON-RPC
// 15M gas cap; the SDK uploads it via FileService → ContractCreate.
//
// Router was deployed in a previous run — to skip, set ROUTER_ADDRESS in env.
let router;
const existingRouter = process.env.ROUTER_ADDRESS;
if (existingRouter) {
  console.log(`\n→ Reusing existing ActionRouter @ ${existingRouter}`);
  router = { contractId: "(reused)", evmAddress: existingRouter };
} else {
  // ── 1) Router (7KB — fastest sanity check) ──
  router = await deploy({
    name: "ActionRouter",
    bytecode: routerBytes,
    gas: 4_000_000,
  });
}

// ── 2) SY_HBARX (16KB) ──
let syHbarx;
const existingSyHbarx = process.env.SY_HBARX_ADDRESS;
if (existingSyHbarx) {
  console.log(`\n→ Reusing existing SY_HBARX @ ${existingSyHbarx}`);
  syHbarx = { contractId: "(reused)", evmAddress: existingSyHbarx };
} else {
  syHbarx = await deploy({
    name: "SY_HBARX",
    bytecode: syHbarxBytes,
    params: new ContractFunctionParameters()
      .addAddress(HBARX)
      .addAddress(STADER)
      .addAddress(SY_ADMIN)
      .addUint48(0),
    gas: 12_000_000,
  });
}

// ── 3) SY_SaucerSwapV2LP (20KB) ──
let sySaucer;
const existingSySaucer = process.env.SY_SAUCER_V2_LP_ADDRESS;
if (existingSySaucer) {
  console.log(`\n→ Reusing existing SY_SaucerSwapV2LP @ ${existingSySaucer}`);
  sySaucer = { contractId: "(reused)", evmAddress: existingSySaucer };
} else {
  sySaucer = await deploy({
    name: "SY_SaucerSwapV2LP",
    bytecode: sySaucerBytes,
    params: new ContractFunctionParameters()
      .addString("Fission SY-SaucerV2LP")
      .addString("fSY-SS-V2")
      .addAddress(T0)
      .addAddress(T1)
      .addUint24(POOL_FEE)
      .addInt24(TICK_LOWER)
      .addInt24(TICK_UPPER)
      .addAddress(NPM)
      .addAddress(SY_ADMIN)
      .addUint48(0),
    gas: 12_000_000,
  });
}

// ── 4a) Market deployers (each ~22-23KB; bytecode-isolation for factory). ──
let standardDeployer;
const existingStandardDeployer = process.env.STANDARD_DEPLOYER_ADDRESS;
if (existingStandardDeployer) {
  console.log(`\n→ Reusing existing StandardMarketDeployer @ ${existingStandardDeployer}`);
  standardDeployer = { contractId: "(reused)", evmAddress: existingStandardDeployer };
} else {
  standardDeployer = await deploy({
    name: "StandardMarketDeployer",
    bytecode: standardDeployerBytes,
    gas: 12_000_000,
  });
}

let rewardsDeployer;
const existingRewardsDeployer = process.env.REWARDS_DEPLOYER_ADDRESS;
if (existingRewardsDeployer) {
  console.log(`\n→ Reusing existing RewardsMarketDeployer @ ${existingRewardsDeployer}`);
  rewardsDeployer = { contractId: "(reused)", evmAddress: existingRewardsDeployer };
} else {
  rewardsDeployer = await deploy({
    name: "RewardsMarketDeployer",
    bytecode: rewardsDeployerBytes,
    gas: 12_000_000,
  });
}

// ── 4b) Factory (~8KB after deployer extraction — fits in any path). ──
let factory;
const existingFactory = process.env.FACTORY_ADDRESS;
if (existingFactory) {
  console.log(`\n→ Reusing existing FissionFactory @ ${existingFactory}`);
  factory = { contractId: "(reused)", evmAddress: existingFactory };
} else {
  factory = await deploy({
    name: "FissionFactory",
    bytecode: factoryBytes,
    params: new ContractFunctionParameters()
      .addAddress(FACTORY_ADMIN)
      .addAddress(MARKET_ADMIN)
      .addAddress(MARKET_TREASURY)
      .addAddress(standardDeployer.evmAddress)
      .addAddress(rewardsDeployer.evmAddress),
    gas: 8_000_000,
  });
}

// ── 5) Persist + summary ──
const out = {
  chainId: 295,
  network: "mainnet",
  deployedAt: new Date().toISOString(),
  factory:           { id: factory.contractId,          evm: factory.evmAddress },
  router:            { id: router.contractId,           evm: router.evmAddress },
  sy_hbarx:          { id: syHbarx.contractId,          evm: syHbarx.evmAddress },
  sy_saucer_v2_lp:   { id: sySaucer.contractId,         evm: sySaucer.evmAddress },
  standard_deployer: { id: standardDeployer.contractId, evm: standardDeployer.evmAddress },
  rewards_deployer:  { id: rewardsDeployer.contractId,  evm: rewardsDeployer.evmAddress },
  deployer:       operatorIdStr,
  deployerEvm:    evmAddr,
  factoryAdmin: FACTORY_ADMIN,
  marketAdmin: MARKET_ADMIN,
  marketTreasury: MARKET_TREASURY,
  syAdmin: SY_ADMIN,
  keeper: KEEPER,
  notes: "Roles still need: KEEPER_ROLE on SY_HBARX, proposeSY for both. Then 7d wait → confirmSY + createMarket / createRewardsMarket.",
};

const deployDir = join(REPO, "deployments");
mkdirSync(deployDir, { recursive: true });
writeFileSync(join(deployDir, "295.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`\n──────────────────────────────────────────────`);
console.log(`  ✅ Core contracts deployed.`);
console.log(`──────────────────────────────────────────────`);
console.log(`  Factory          : ${factory.contractId}  (${factory.evmAddress})`);
console.log(`  Router           : ${router.contractId}  (${router.evmAddress})`);
console.log(`  SY_HBARX         : ${syHbarx.contractId}  (${syHbarx.evmAddress})`);
console.log(`  SY_SaucerSwapV2LP: ${sySaucer.contractId}  (${sySaucer.evmAddress})`);
console.log(`──────────────────────────────────────────────`);
console.log(`  Wrote deployments/295.json`);
console.log(`──────────────────────────────────────────────`);
console.log(`\n  TODO post-deploy (run scripts/post-deploy.mjs):`);
console.log(`  - Grant KEEPER_ROLE on SY_HBARX to ${KEEPER}`);
console.log(`  - factory.proposeSY(${syHbarx.evmAddress})`);
console.log(`  - factory.proposeSY(${sySaucer.evmAddress})`);
console.log(`  - Wait 7 days, then confirmSY + createMarket / createRewardsMarket.`);

client.close();
