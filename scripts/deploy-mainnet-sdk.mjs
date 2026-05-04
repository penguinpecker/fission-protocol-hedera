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
  ContractFunctionParameters,
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
  const tx = new ContractCreateFlow()
    .setBytecode(bytecode)
    .setGas(gas);
  if (params) tx.setConstructorParameters(params);
  if (payableHbar > 0) tx.setInitialBalance(new Hbar(payableHbar));
  const submit = await tx.execute(client);
  const receipt = await submit.getReceipt(client);
  const id = receipt.contractId;
  // Long-zero EVM alias for the contract.
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
const syHbarx = await deploy({
  name: "SY_HBARX",
  bytecode: syHbarxBytes,
  params: new ContractFunctionParameters()
    .addAddress(HBARX)
    .addAddress(STADER)
    .addAddress(SY_ADMIN)
    .addUint48(0),
  gas: 12_000_000,
  payableHbar: 10,
});

// ── 3) SY_SaucerSwapV2LP (20KB) ──
const sySaucer = await deploy({
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
  payableHbar: 10,
});

// ── 4) Factory (71KB — last; if file-append times out, retry). ──
const factory = await deploy({
  name: "FissionFactory",
  bytecode: factoryBytes,
  params: new ContractFunctionParameters()
    .addAddress(FACTORY_ADMIN)
    .addAddress(MARKET_ADMIN)
    .addAddress(MARKET_TREASURY),
  gas: 14_000_000,
});

// ── 5) Persist + summary ──
const out = {
  chainId: 295,
  network: "mainnet",
  deployedAt: new Date().toISOString(),
  factory:        { id: factory.contractId,    evm: factory.evmAddress },
  router:         { id: router.contractId,     evm: router.evmAddress },
  sy_hbarx:       { id: syHbarx.contractId,    evm: syHbarx.evmAddress },
  sy_saucer_v2_lp:{ id: sySaucer.contractId,   evm: sySaucer.evmAddress },
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
