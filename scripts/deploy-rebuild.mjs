#!/usr/bin/env node
// Clean-slate Fission Protocol redeploy (2026-05-27 onward).
//
// Deploys (in order) via Hashio JSON-RPC + viem:
//   1. StandardMarketDeployer
//   2. RewardsMarketDeployer        (updated → FissionRewardsMarket)
//   3. FissionFactory               (updated MarketCreated event with lp + marketType)
//   4. SaucerSwapLPYieldSource      (SY adapter, NPM pre-approved at initShareToken)
//   5. FissionLens
//   6. FissionPeriphery             (consolidated 2-tx user-facing contract)
//
// Then orchestrates:
//   - sy.initShareToken{value: 20 HBAR}
//   - factory.proposeSY + factory.confirmSY
//   - factory.createRewardsMarket{value: 30 HBAR}
//   - periphery.registerMarket(market) (only if not pre-registered in constructor)
//
// Reads .env:
//   NEW_DEPLOYER_KEY        ECDSA hex (required)
//   NEW_DEPLOYER_ID         Hedera account ID (auto-populated via mirror if missing)
//   FACTORY_ADMIN, MARKET_ADMIN, MARKET_TREASURY, SY_ADMIN  (default = deployer EVM)
//   MARKET_EXPIRY           Unix seconds (default: now + 90 days)
//   SCALAR_ROOT             default 5e18
//   MARKET_SUFFIX           default "USDC-WHBAR-{date}"
//
// Writes deployments/295.json — addresses for the frontend cutover.

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeDeployData,
  parseEther,
  getAddress,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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

const KEY = (process.env.NEW_DEPLOYER_KEY || "").trim();
if (!KEY) throw new Error("NEW_DEPLOYER_KEY missing in .env");
const PK = KEY.startsWith("0x") ? KEY : "0x" + KEY;
const account = privateKeyToAccount(PK);

const RPC_URL = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
const chain = {
  id: 295,
  name: "Hedera Mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

const FACTORY_ADMIN   = getAddress(process.env.FACTORY_ADMIN   || account.address);
const MARKET_ADMIN    = getAddress(process.env.MARKET_ADMIN    || account.address);
const MARKET_TREASURY = getAddress(process.env.MARKET_TREASURY || account.address);
const SY_ADMIN        = getAddress(process.env.SY_ADMIN        || account.address);

// Pinned Hedera mainnet addresses.
const NPM            = getAddress("0x00000000000000000000000000000000003ddbb9");
const USDC           = getAddress("0x000000000000000000000000000000000006f89a");
const WHBAR          = getAddress("0x0000000000000000000000000000000000163b5a");
const WHBAR_CONTRACT = getAddress("0x0000000000000000000000000000000000163b59");
const V2_ROUTER      = getAddress("0x00000000000000000000000000000000003c437a");

const POOL_FEE   = 1500;
const TICK_LOWER = -887220;
const TICK_UPPER =  887220;

const T0 = USDC.toLowerCase() < WHBAR.toLowerCase() ? USDC : WHBAR;
const T1 = USDC.toLowerCase() < WHBAR.toLowerCase() ? WHBAR : USDC;

function loadArtifact(path) {
  const json = JSON.parse(readFileSync(join(REPO, "contracts/out", path), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}
const artStd       = loadArtifact("StandardMarketDeployer.sol/StandardMarketDeployer.json");
const artRwd       = loadArtifact("RewardsMarketDeployer.sol/RewardsMarketDeployer.json");
const artFactory   = loadArtifact("FissionFactory.sol/FissionFactory.json");
const artSY        = loadArtifact("SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json");
const artLens      = loadArtifact("FissionLens.sol/FissionLens.json");
const artPeriphery = loadArtifact("FissionPeriphery.sol/FissionPeriphery.json");

console.log("══════════════════════════════════════════════════════════════════");
console.log("  Fission Protocol — Clean-slate Redeploy");
console.log("══════════════════════════════════════════════════════════════════");
console.log(`  Deployer       : ${account.address}`);
console.log(`  Factory admin  : ${FACTORY_ADMIN}`);
console.log(`  Market admin   : ${MARKET_ADMIN}`);
console.log(`  Market treasury: ${MARKET_TREASURY}`);
console.log(`  SY admin       : ${SY_ADMIN}`);

const balance = await publicClient.getBalance({ address: account.address });
console.log(`  Balance        : ${(Number(balance) / 1e18).toFixed(4)} HBAR`);
if (balance < parseEther("100")) {
  throw new Error("Insufficient balance (need ~925 HBAR for full deploy + market init).");
}

// Hashio min gas price floor: 960 gwei mainnet. Bump to 1100 to clear margin.
const GAS_PRICE = 1_100_000_000_000n;

async function deploy({ name, abi, bytecode, args = [], value = 0n, gas = 15_000_000n }) {
  const data = encodeDeployData({ abi, bytecode, args });
  console.log(`\n→ Deploying ${name}…`);
  const hash = await walletClient.sendTransaction({ data, value, gas, gasPrice: GAS_PRICE });
  console.log(`  tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${name} deploy failed (status=${receipt.status})`);
  console.log(`  ✓ ${name} @ ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function callContract({ name, address, abi, functionName, args, value = 0n, gas = 3_000_000n }) {
  console.log(`\n→ ${name}.${functionName}(...)`);
  const { request } = await publicClient.simulateContract({
    account, address, abi, functionName, args, value, gas, gasPrice: GAS_PRICE,
  }).catch((e) => {
    // Hedera precompile calls revert in revm simulation — skip sim and send anyway.
    return { request: { account, address, abi, functionName, args, value, gas, gasPrice: GAS_PRICE } };
  });
  const hash = await walletClient.writeContract(request);
  console.log(`  tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${name}.${functionName} failed (status=${receipt.status})`);
  console.log(`  ✓ status=${receipt.status}`);
  return receipt;
}

// ── 1. StandardMarketDeployer ──
const stdDeployer = await deploy({
  name: "StandardMarketDeployer", abi: artStd.abi, bytecode: artStd.bytecode, gas: 10_000_000n,
});

// ── 2. RewardsMarketDeployer ──
const rwdDeployer = await deploy({
  name: "RewardsMarketDeployer", abi: artRwd.abi, bytecode: artRwd.bytecode, gas: 11_000_000n,
});

// ── 3. FissionFactory ──
const factory = await deploy({
  name: "FissionFactory", abi: artFactory.abi, bytecode: artFactory.bytecode,
  args: [FACTORY_ADMIN, MARKET_ADMIN, MARKET_TREASURY, stdDeployer, rwdDeployer, 0n],
  gas: 6_000_000n,
});

// ── 4. SaucerSwapLPYieldSource ──
const sy = await deploy({
  name: "SaucerSwapLPYieldSource", abi: artSY.abi, bytecode: artSY.bytecode,
  args: [
    "Fission SY SaucerSwap V2 USDC-WHBAR",
    "fSY-USDC-WHBAR",
    T0, T1,
    POOL_FEE,
    TICK_LOWER, TICK_UPPER,
    NPM,
    SY_ADMIN,
    0, // adminTransferDelay
  ],
  gas: 10_000_000n,
});

// ── 5. SY.initShareToken{value: 20 HBAR} — creates HTS-native fSY token + pre-approves NPM ──
await callContract({
  name: "SY", address: sy, abi: artSY.abi,
  functionName: "initShareToken", args: [],
  value: parseEther("20"), gas: 4_000_000n,
});

// ── 6. Factory.proposeSY + Factory.confirmSY ──
await callContract({
  name: "Factory", address: factory, abi: artFactory.abi,
  functionName: "proposeSY", args: [sy], gas: 1_000_000n,
});
await callContract({
  name: "Factory", address: factory, abi: artFactory.abi,
  functionName: "confirmSY", args: [sy], gas: 1_000_000n,
});

// ── 7. Factory.createRewardsMarket{value: 30 HBAR} ──
const EXPIRY = BigInt(process.env.MARKET_EXPIRY || Math.floor(Date.now() / 1000) + 86400 * 90);
const SCALAR_ROOT = BigInt(process.env.SCALAR_ROOT || "5000000000000000000");
const SUFFIX = process.env.MARKET_SUFFIX || `USDC-WHBAR-${new Date(Number(EXPIRY) * 1000).toISOString().slice(0, 10)}`;
console.log(`\n→ Factory.createRewardsMarket(expiry=${EXPIRY}, scalar=${SCALAR_ROOT}, suffix=${SUFFIX})`);
const createReceipt = await callContract({
  name: "Factory", address: factory, abi: artFactory.abi,
  functionName: "createRewardsMarket",
  args: [sy, EXPIRY, SCALAR_ROOT, SUFFIX],
  value: parseEther("30"), gas: 14_000_000n,
});

// Decode MarketCreated event for the new market address.
let marketAddr = null;
for (const log of createReceipt.logs) {
  try {
    const evt = decodeEventLog({ abi: artFactory.abi, data: log.data, topics: log.topics });
    if (evt.eventName === "MarketCreated") {
      marketAddr = evt.args.market;
      console.log(`  Market: ${marketAddr} (PT=${evt.args.pt}, YT=${evt.args.yt}, LP=${evt.args.lp})`);
      break;
    }
  } catch {}
}
if (!marketAddr) throw new Error("MarketCreated event not found in receipt logs");

// ── 8. FissionLens ──
const lens = await deploy({
  name: "FissionLens", abi: artLens.abi, bytecode: artLens.bytecode, gas: 2_000_000n,
});

// ── 9. FissionPeriphery (pre-register the new market) ──
const periphery = await deploy({
  name: "FissionPeriphery", abi: artPeriphery.abi, bytecode: artPeriphery.bytecode,
  args: [WHBAR_CONTRACT, WHBAR, USDC, V2_ROUTER, NPM, [marketAddr]],
  gas: 10_000_000n,
});

// ── Persist deployment record ──
const deployDir = join(REPO, "deployments");
mkdirSync(deployDir, { recursive: true });
const outPath = join(deployDir, "295.json");
const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};

const out = {
  chainId: 295,
  network: "mainnet",
  deployedAt: new Date().toISOString(),
  deployer: account.address,
  roles: { factoryAdmin: FACTORY_ADMIN, marketAdmin: MARKET_ADMIN, marketTreasury: MARKET_TREASURY, syAdmin: SY_ADMIN },
  external: { NPM, USDC, WHBAR, WHBAR_CONTRACT, V2_ROUTER, POOL_FEE, TICK_LOWER, TICK_UPPER },
  contracts: {
    standardMarketDeployer: stdDeployer,
    rewardsMarketDeployer:  rwdDeployer,
    factory,
    saucerSwapLPYieldSource: sy,
    lens,
    periphery,
  },
  market: {
    address: marketAddr,
    expiry: EXPIRY.toString(),
    scalarRoot: SCALAR_ROOT.toString(),
    suffix: SUFFIX,
  },
  abandoned: existing.abandoned || existing,
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  ✅ Clean-slate redeploy complete — wrote " + outPath);
console.log("══════════════════════════════════════════════════════════════════");
console.log(`  Factory     : ${factory}`);
console.log(`  SY adapter  : ${sy}`);
console.log(`  Market      : ${marketAddr}`);
console.log(`  Lens        : ${lens}`);
console.log(`  Periphery   : ${periphery}`);
console.log("══════════════════════════════════════════════════════════════════");
console.log("\n  NEXT (in order):");
console.log("    a. Operator seeds V3 NFT: scripts/seed-v3-nft.mjs");
console.log("    b. Operator seeds market: scripts/seed-market.mjs");
console.log("    c. Frontend cutover: frontend/src/lib/addresses.ts");
console.log("    d. Smoke each leg:    scripts/smoke-rebuild.mjs");
