#!/usr/bin/env node
// redeploy-amm-redirect.mjs — full cascade for the 2026-05-29 AMM fee redirect.
//
// What it does (single transactional flow):
//   1. Zap operator HBAR → SY-shares (we'll need ~300 SY for bootstrap + LP).
//   2. Deploy StandardMarketDeployer.
//   3. Deploy RewardsMarketDeployer  ← carries the NEW FissionRewardsMarket
//      bytecode with 99% PT+YT / 1% deployer fee redirect.
//   4. Deploy FissionFactory(admin=op, marketAdmin=op, marketTreasury=op,
//      stdDep, rwdDep, syReviewWindow_=0)  ← 0 = no audit cooldown.
//   5. Factory.proposeSY(SY adapter)   (op has SY_REVIEWER_ROLE).
//   6. Factory.confirmSY(SY adapter)   (op has DEFAULT_ADMIN_ROLE; no wait).
//   7. Factory.createRewardsMarket(...) {value: 70 HBAR for HTS creates}.
//   8. Periphery.registerMarket(newMarket).
//   9. SY.approve(market, int64.max) → market.split(half_op_sy).
//  10. PT.approve(market, int64.max) → market.initialize(SEED, SEED, anchor8pct,…)
//  11. market.addLiquidity(remaining, remaining, 0, op) to deepen the pool.
//  12. Persist deployments/295.json — record old market in previousMarkets[].
//
// Reuses (unchanged):
//   - SY adapter (SaucerSwapLPYieldSource) at 0x…A0289A
//   - Periphery at 0x…A02731
//   - Lens at 0xa1aA…1969
//
// Replaces:
//   - Factory + both Deployers + Market

import {
  createPublicClient, createWalletClient, http, parseEther, getAddress, decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
for (const l of readFileSync(join(REPO, ".env"), "utf8").split("\n")) {
  const e = l.indexOf("="); if (e < 0) continue;
  const k = l.slice(0, e).trim(); let v = l.slice(e + 1).trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const PK = ("0x" + process.env.NEW_DEPLOYER_KEY.replace(/^0x/, "")).trim();
const account = privateKeyToAccount(PK);
const chain = {
  id: 295,
  name: "Hedera",
  nativeCurrency: { decimals: 18, symbol: "HBAR", name: "HBAR" },
  rpcUrls: { default: { http: ["https://mainnet.hashio.io/api"] } },
};
const pub = createPublicClient({ chain, transport: http() });
const wlt = createWalletClient({ account, chain, transport: http() });
const GAS_PRICE = 1_100_000_000_000n;

const dep = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
const sy        = getAddress(dep.contracts.saucerSwapLPYieldSource);
const periphery = getAddress(dep.contracts.periphery);
const oldMarket = getAddress(dep.market.address);
const oldFactory = getAddress(dep.contracts.factory);

const artFactory       = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionFactory.sol/FissionFactory.json"), "utf8"));
const artStandardDep   = JSON.parse(readFileSync(join(REPO, "contracts/out/StandardMarketDeployer.sol/StandardMarketDeployer.json"), "utf8"));
const artRewardsDep    = JSON.parse(readFileSync(join(REPO, "contracts/out/RewardsMarketDeployer.sol/RewardsMarketDeployer.json"), "utf8"));
const artMarket        = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8"));
const artPeriphery     = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8"));
const artSY            = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8"));

const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve",   inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INT64_MAX = (1n << 63n) - 1n;

async function send(label, req) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(req);
  const rec = await pub.waitForTransactionReceipt({ hash });
  if (rec.status !== "success") {
    const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
    if (r.ok) console.error("  error:", (await r.json()).error_message);
    throw new Error(`${label} reverted`);
  }
  console.log(`  ✓ ${hash}`);
  return rec;
}

async function deploy(label, art, args, value = 0n) {
  console.log(`→ ${label}`);
  const hash = await wlt.deployContract({
    abi: art.abi, bytecode: art.bytecode.object, args,
    value, gas: 12_000_000n, gasPrice: GAS_PRICE,
  });
  const rec = await pub.waitForTransactionReceipt({ hash });
  if (rec.status !== "success" || !rec.contractAddress) throw new Error(`${label} failed`);
  console.log(`  ✓ ${rec.contractAddress}   tx=${hash}`);
  return rec.contractAddress;
}

// ── preflight ─────────────────────────────────────────────────────────
console.log(`Deployer: ${account.address}`);
const bal0 = await pub.getBalance({ address: account.address });
const hbarBal = Number(bal0) / 1e18;
console.log(`Balance:  ${hbarBal.toFixed(2)} HBAR`);
if (hbarBal < 130) { console.error("Need ≥130 HBAR for the remaining cascade (RewardsDeployer+Factory+createMarket)."); process.exit(1); }

const shareToken = await pub.readContract({ address: sy, abi: artSY.abi, functionName: "shareToken" });
console.log(`SY adapter:  ${sy}`);
console.log(`Share token: ${shareToken}`);
console.log(`Periphery:   ${periphery}`);
console.log(`Old market:  ${oldMarket}\n`);

// ── 1. zap HBAR → SY ──────────────────────────────────────────────────
// Skipped — first cascade attempt already zapped 250 HBAR; operator holds
// ~367 SY-shares (verified pre-run). Re-zapping would burn HBAR for no gain.
const sySharesNow = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`[1] Skip zap — operator already has ${sySharesNow} SY-shares from prior attempt.`);
if (sySharesNow < 200_000_000n) {
  console.error("Operator SY < 200 — need to zap. Re-enable the zap step in this script.");
  process.exit(1);
}

// ── 2. reuse StandardMarketDeployer from prior cascade attempt ───────
const standardDep = getAddress("0x8d56747f585cb9f95a2c9c20c2cdb11b46806679");
console.log(`[2] Reusing StandardMarketDeployer: ${standardDep}`);

// ── 3. deploy RewardsMarketDeployer (NEW bytecode w/ AMM redirect) ───
const rewardsDep = await deploy("[3] RewardsMarketDeployer", artRewardsDep, []);
await sleep(4000);

// ── 4. deploy FissionFactory (syReviewWindow=0 → no cooldown) ────────
// constructor(admin, marketAdmin, marketTreasury, stdDep, rwdDep, syReviewWindow)
const factory = await deploy("[4] FissionFactory(syReviewWindow=0)", artFactory, [
  account.address,  // admin (gets SY_REVIEWER_ROLE + DEFAULT_ADMIN + MARKET_CREATOR)
  account.address,  // marketAdmin (each market's admin)
  account.address,  // marketTreasury (receives 1% AMM-fee deployer cut)
  standardDep,
  rewardsDep,
  0n,               // syReviewWindow_ = 0
]);
await sleep(8000);

// ── 5. proposeSY(SY adapter) ─────────────────────────────────────────
console.log(`[5] Factory.proposeSY(${sy})`);
await send("proposeSY", {
  account, address: factory, abi: artFactory.abi, functionName: "proposeSY",
  args: [sy], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await sleep(4000);

// ── 6. confirmSY(SY adapter) ─────────────────────────────────────────
console.log(`[6] Factory.confirmSY(${sy})  (no cooldown wait)`);
await send("confirmSY", {
  account, address: factory, abi: artFactory.abi, functionName: "confirmSY",
  args: [sy], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await sleep(4000);

// ── 7. createRewardsMarket ───────────────────────────────────────────
const EXPIRY = BigInt(dep.market.expiry);
const SCALAR_ROOT = BigInt("5000000000000000000");
const SUFFIX = `USDC-WHBAR-${new Date(Number(EXPIRY) * 1000).toISOString().slice(0, 10)}-amm`;

const nowSec = BigInt(Math.floor(Date.now() / 1000));
const timeToExpiry = Number(EXPIRY - nowSec);
const YEAR_SEC = 365 * 24 * 3600;
const TARGET_APY = 0.08;
const targetLnRate = Math.log(1 + TARGET_APY);
const lnAnchorTarget = targetLnRate * timeToExpiry / YEAR_SEC;
const ANCHOR_FLOAT = Math.exp(lnAnchorTarget);
const ANCHOR = BigInt(Math.round(ANCHOR_FLOAT * 1e18));
console.log(`[7] Factory.createRewardsMarket(suffix=${SUFFIX}, expiry=${EXPIRY})`);
console.log(`    Time-to-expiry: ${(timeToExpiry/86400).toFixed(2)} days`);
console.log(`    Anchor for 8% APY: ${ANCHOR_FLOAT.toFixed(6)} (= ${ANCHOR})`);

const cmRec = await send("createRewardsMarket (value=70 HBAR)", {
  account, address: factory, abi: artFactory.abi, functionName: "createRewardsMarket",
  args: [sy, EXPIRY, SCALAR_ROOT, SUFFIX],
  value: parseEther("70"), gas: 14_000_000n, gasPrice: GAS_PRICE,
});

let market = null;
for (const log of cmRec.logs) {
  try {
    const evt = decodeEventLog({ abi: artFactory.abi, data: log.data, topics: log.topics });
    if (evt.eventName === "MarketCreated") { market = evt.args.market; break; }
  } catch {}
}
if (!market) throw new Error("MarketCreated event not found in createRewardsMarket receipt");
console.log(`  → New market: ${market}\n`);

const newPT = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "pt" });
const newYT = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "yt" });
const newLP = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "lp" });
console.log(`  PT: ${newPT}\n  YT: ${newYT}\n  LP: ${newLP}\n`);

// ── 8. Periphery.registerMarket ──────────────────────────────────────
console.log(`[8] Periphery.registerMarket(${market})`);
await send("registerMarket", {
  account, address: periphery, abi: artPeriphery.abi, functionName: "registerMarket",
  args: [market], gas: 10_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

// ── 9. SY.approve(market) → split(half) ──────────────────────────────
console.log(`[9a] SY.approve(market, int64.max)`);
await send("SY.approve", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [market, INT64_MAX], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await sleep(4000);

const opSyNow = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const half = opSyNow / 2n;
console.log(`[9b] market.split(${half})  (operator SY: ${opSyNow})`);
await send("split", {
  account, address: market, abi: artMarket.abi, functionName: "split",
  args: [half], gas: 4_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

// ── 10. PT.approve + initialize ──────────────────────────────────────
console.log(`[10a] PT.approve(market, int64.max)`);
await send("PT.approve", {
  account, address: newPT, abi: erc20Abi, functionName: "approve",
  args: [market, INT64_MAX], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await sleep(4000);

const SEED = 10_000_000n;         // 10 SY-share + 10 PT bootstrap
const LN_FEE = BigInt("10000000000000000");
const RESERVE = 50n;
console.log(`[10b] market.initialize(SEED=${SEED}, anchor=${ANCHOR})`);
await send("initialize", {
  account, address: market, abi: artMarket.abi, functionName: "initialize",
  args: [SEED, SEED, ANCHOR, LN_FEE, RESERVE],
  gas: 4_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

const lnRate = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "lastLnImpliedRate" });
const apyInit = (Math.exp(Number(lnRate) / 1e18) - 1) * 100;
console.log(`  lastLnImpliedRate: ${lnRate}  (= ${apyInit.toFixed(2)}% APY)`);
if (Math.abs(apyInit - 8) > 2) {
  console.warn(`  ⚠ APY ${apyInit.toFixed(2)}% diverges from 8% — aborting LP add. Investigate.`);
  process.exit(0);
}

// ── 11. addLiquidity to deepen ───────────────────────────────────────
const remSY = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const remPT = await pub.readContract({ address: newPT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const lpAmount = remSY < remPT ? remSY : remPT;
console.log(`[11] market.addLiquidity(${lpAmount}, ${lpAmount}, 0, op)  (remSY=${remSY}, remPT=${remPT})`);
if (lpAmount > 1_000_000n) {
  await send("addLiquidity", {
    account, address: market, abi: artMarket.abi, functionName: "addLiquidity",
    args: [lpAmount, lpAmount, 0n, account.address],
    gas: 4_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);
} else {
  console.log("  Skip — too little to deepen.");
}

const finalLnRate = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "lastLnImpliedRate" });
const finalApy = (Math.exp(Number(finalLnRate) / 1e18) - 1) * 100;
const finalTotalSy = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "totalSy" });
const finalTotalPt = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "totalPt" });

console.log(`\nFinal state:`);
console.log(`  APY:      ${finalApy.toFixed(2)}%`);
console.log(`  totalSy:  ${finalTotalSy}`);
console.log(`  totalPt:  ${finalTotalPt}`);

// ── 12. persist ──────────────────────────────────────────────────────
dep.previousMarkets = dep.previousMarkets || [];
dep.previousMarkets.push({
  address: oldMarket,
  reason: "replaced by AMM fee redirect (49.5% PT / 49.5% YT / 1% deployer)",
  expiry: dep.market.expiry,
  factory: oldFactory,
});

dep.contracts.standardMarketDeployer = standardDep;
dep.contracts.rewardsMarketDeployer = rewardsDep;
dep.contracts.factory = factory;
dep.market = {
  address: market,
  expiry: EXPIRY.toString(),
  scalarRoot: SCALAR_ROOT.toString(),
  suffix: SUFFIX,
  anchor: ANCHOR.toString(),
  anchorNote: `${ANCHOR_FLOAT.toFixed(6)}e18 = 8% annualized APY at deploy time (${(timeToExpiry/86400).toFixed(0)} days to expiry).`,
};
dep.ammFeeRedirect = {
  ts: new Date().toISOString(),
  ptBps: 4950,
  ytBps: 4950,
  deployerBps: 100,
  feeToken: "shareToken (SY)",
  notes: "Factory + deployers + market redeployed with FissionRewardsMarket v: AMM swap fees now split 99% to PT+YT holders, 1% to deployer (treasury). Old market preserved in previousMarkets[] for historical state. SY adapter / Periphery / Lens unchanged.",
};

writeFileSync(join(REPO, "deployments/295.json"), JSON.stringify(dep, null, 2) + "\n");

console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`  ✅ Cascade complete`);
console.log(`     New Factory: ${factory}`);
console.log(`     New Market:  ${market}`);
console.log(`     APY:         ${finalApy.toFixed(2)}%`);
console.log(`     NEXT: update Vercel env NEXT_PUBLIC_FACTORY_ADDRESS + NEXT_PUBLIC_MARKET_ADDRESS`);
console.log(`══════════════════════════════════════════════════════════════════`);
