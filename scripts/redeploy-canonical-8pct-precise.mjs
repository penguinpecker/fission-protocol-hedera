#!/usr/bin/env node
// redeploy-canonical-8pct-precise.mjs — second pass after the first
// redeploy got APY=37% instead of 8% (anchor formula misunderstanding).
//
// Pendle V2 reality: anchor is a "rate factor over the full year period";
// the contract then ANNUALIZES it by (yearSec / timeToExpiry). So with
// 89 days left, anchor=1.08 → implied APY = 1.08^(365/89) ≈ 37%.
//
// Correct anchor for desired annualized APY A:
//   anchor = exp(ln(1+A) * timeToExpiry / yearSec)
//
// For A=0.08 and ~89 days: anchor ≈ 1.019e18.

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
const chain = { id: 295, name: "Hedera", nativeCurrency: { decimals: 18, symbol: "HBAR", name: "HBAR" }, rpcUrls: { default: { http: ["https://mainnet.hashio.io/api"] } } };
const pub = createPublicClient({ chain, transport: http() });
const wlt = createWalletClient({ account, chain, transport: http() });
const GAS_PRICE = 1_100_000_000_000n;

const dep = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
const factory   = getAddress(dep.contracts.factory);
const sy        = getAddress(dep.contracts.saucerSwapLPYieldSource);
const periphery = getAddress(dep.contracts.periphery);
const failedMarket = getAddress(dep.market.address); // the 37%-APY market we just made

const artFactory   = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionFactory.sol/FissionFactory.json"), "utf8"));
const artPeriphery = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8"));
const artMarket    = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8"));
const artSY        = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8"));
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Deployer: ${account.address}`);
const bal0 = await pub.getBalance({ address: account.address });
console.log(`Balance:  ${(Number(bal0) / 1e18).toFixed(2)} HBAR`);
if (bal0 < parseEther("80")) { console.error("Need ≥80 HBAR. Top up first."); process.exit(1); }

// Compute the CORRECT anchor for 8% annualized APY given current time-to-expiry
const EXPIRY = BigInt(dep.market.expiry);
const nowSec = BigInt(Math.floor(Date.now() / 1000));
const timeToExpiry = Number(EXPIRY - nowSec);
const YEAR_SEC = 365 * 24 * 3600;
const TARGET_APY = 0.08;
const targetLnRate = Math.log(1 + TARGET_APY); // = 0.077
const lnAnchorTarget = targetLnRate * timeToExpiry / YEAR_SEC;
const ANCHOR_FLOAT = Math.exp(lnAnchorTarget);
const ANCHOR = BigInt(Math.round(ANCHOR_FLOAT * 1e18));
console.log(`Time to expiry: ${(timeToExpiry/86400).toFixed(2)} days`);
console.log(`Target APY:     8.00%`);
console.log(`Anchor computed: ${ANCHOR_FLOAT.toFixed(6)} (= ${ANCHOR})`);
console.log(`Sanity: anchor^(yearSec/timeToExpiry) = ${(ANCHOR_FLOAT ** (YEAR_SEC/timeToExpiry)).toFixed(4)} (should be ~1.08)\n`);

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

const shareToken = await pub.readContract({ address: sy, abi: artSY.abi, functionName: "shareToken" });
const failedPT = await pub.readContract({ address: failedMarket, abi: artMarket.abi, functionName: "pt" });
const failedLP = await pub.readContract({ address: failedMarket, abi: artMarket.abi, functionName: "lp" });

const opSyBefore = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const opPtBefore = await pub.readContract({ address: failedPT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const opLpBefore = await pub.readContract({ address: failedLP, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`Pre-flight operator holdings:`);
console.log(`  SY (shared with all markets): ${opSyBefore}`);
console.log(`  PT (failed market): ${opPtBefore}`);
console.log(`  LP (failed market): ${opLpBefore}\n`);

// [1] Drain LP from the failed market (37% APY one) → get back SY + PT
if (opLpBefore > 0n) {
  console.log(`[1] failedMarket.removeLiquidity(${opLpBefore})`);
  await send("removeLiquidity (failed)", {
    account, address: failedMarket, abi: artMarket.abi, functionName: "removeLiquidity",
    args: [opLpBefore, 1n, 1n, account.address], gas: 4_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);
}

const opSyAfter = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`After drain: SY=${opSyAfter}\n`);

// [2] Create new market
const SCALAR_ROOT = BigInt("5000000000000000000");
const SUFFIX = `USDC-WHBAR-${new Date(Number(EXPIRY) * 1000).toISOString().slice(0, 10)}-fix8`;
console.log(`[2] Factory.createRewardsMarket(suffix=${SUFFIX})`);
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
if (!market) throw new Error("MarketCreated event not found");
console.log(`  → New market: ${market}\n`);

const newPT = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "pt" });
const newYT = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "yt" });
const newLP = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "lp" });
console.log(`  PT: ${newPT}\n  YT: ${newYT}\n  LP: ${newLP}\n`);

// [3] Register
console.log(`[3] Periphery.registerMarket`);
await send("registerMarket", {
  account, address: periphery, abi: artPeriphery.abi, functionName: "registerMarket",
  args: [market], gas: 10_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

// [4] Approve SY → split
console.log(`[4a] SY.approve(newMarket, max)`);
await send("SY.approve", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await sleep(4000);

const opSyNow = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const half = opSyNow / 2n;
console.log(`[4b] market.split(${half})`);
await send("split", {
  account, address: market, abi: artMarket.abi, functionName: "split",
  args: [half], gas: 4_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

const newPtBal = await pub.readContract({ address: newPT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`  → new-PT balance: ${newPtBal}\n`);

// [5] Approve PT + initialize with the CORRECT anchor
console.log(`[5a] PT.approve(newMarket, max)`);
await send("PT.approve", {
  account, address: newPT, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await sleep(4000);

const SEED_SY = 10_000_000n;
const SEED_PT = 10_000_000n;
const LN_FEE = BigInt("10000000000000000");
const RESERVE = 50n;

console.log(`[5b] market.initialize(${SEED_SY}, ${SEED_PT}, anchor=${ANCHOR}, lnFee=0.01e18, reserve=50)`);
await send("initialize", {
  account, address: market, abi: artMarket.abi, functionName: "initialize",
  args: [SEED_SY, SEED_PT, ANCHOR, LN_FEE, RESERVE],
  gas: 4_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

const lnRate = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "lastLnImpliedRate" });
const apyInit = (Math.exp(Number(lnRate)/1e18)-1)*100;
console.log(`  → initial lastLnImpliedRate: ${lnRate} (= ${apyInit.toFixed(2)}% APY)\n`);

if (Math.abs(apyInit - 8) > 2) {
  console.warn(`  ⚠ Initial APY (${apyInit.toFixed(2)}%) NOT close to 8% — aborting LP add. Investigate before adding more liquidity.`);
  process.exit(0);
}

// [6] Deepen with remaining SY + PT
const remainingSY = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const remainingPT = await pub.readContract({ address: newPT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`[6] LP add: SY=${remainingSY} PT=${remainingPT}`);
const lpAmount = remainingSY < remainingPT ? remainingSY : remainingPT;
if (lpAmount > 1_000_000n) {
  await send("addLiquidity", {
    account, address: market, abi: artMarket.abi, functionName: "addLiquidity",
    args: [lpAmount, lpAmount, 0n, account.address],
    gas: 4_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);
}

const finalLnRate = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "lastLnImpliedRate" });
const finalTotalSy = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "totalSy" });
const finalTotalPt = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "totalPt" });
const finalApy = (Math.exp(Number(finalLnRate)/1e18)-1)*100;
console.log(`\nFinal:`);
console.log(`  lastLnImpliedRate: ${finalLnRate} (= ${finalApy.toFixed(2)}% APY)`);
console.log(`  totalSy: ${finalTotalSy}`);
console.log(`  totalPt: ${finalTotalPt}`);

// [7] Persist deployments.json — keep history of failed 37% market
dep.previousMarkets = dep.previousMarkets || [];
dep.previousMarkets.push({
  address: failedMarket,
  reason: `anchor=1.08e18 was a per-year rate factor, not annualized APY; produced 37% APY instead of intended 8%`,
  expiry: dep.market.expiry,
});
dep.market = {
  address: market,
  expiry: EXPIRY.toString(),
  scalarRoot: SCALAR_ROOT.toString(),
  suffix: SUFFIX,
  anchor: ANCHOR.toString(),
  anchorNote: `${ANCHOR_FLOAT.toFixed(6)}e18 = 8% annualized APY at deploy time (${(timeToExpiry/86400).toFixed(0)} days to expiry). Formula: anchor = exp(ln(1+APY) * timeToExpiry / yearSec).`,
};
writeFileSync(join(REPO, "deployments/295.json"), JSON.stringify(dep, null, 2) + "\n");

console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`  ✅ Market: ${market}`);
console.log(`     Initial APY: ${finalApy.toFixed(2)}%`);
console.log(`     NEXT: vercel env NEXT_PUBLIC_MARKET_ADDRESS → ${market}`);
console.log(`══════════════════════════════════════════════════════════════════`);
