#!/usr/bin/env node
// redeploy-canonical-8pct.mjs — fix the 141% APY by deploying a new market
// at anchor=1.08e18 (8% initial APY, matches observed ~9.7% SaucerSwap LP yield).
//
// Steps:
//   1. Drain operator's LP from OLD canonical → SY + PT returned
//   2. Factory.createRewardsMarket(sy, expiry, scalarRoot, suffix) → new market
//   3. Periphery.registerMarket(newMarket) → register so Periphery flows work
//   4. SY.approve(newMarket) → split half operator SY into NEW PT + NEW YT
//   5. PT.approve(newMarket) → Market.initialize(10M SY, 10M PT, anchor=1.08e18)
//   6. Market.addLiquidity(remaining SY, remaining PT, 0, op) → deepen pool
//   7. Write deployments/295.json
//
// AFTER this script: user updates Vercel env NEXT_PUBLIC_MARKET_ADDRESS to
// the new address + triggers a frontend redeploy.

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
const oldMarket = getAddress(dep.market.address);

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
console.log(`Balance:  ${(Number(bal0) / 1e18).toFixed(2)} HBAR\n`);
if (bal0 < parseEther("80")) { console.error("Need ≥80 HBAR. Top up first."); process.exit(1); }

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
const oldPT = await pub.readContract({ address: oldMarket, abi: artMarket.abi, functionName: "pt" });
const oldLP = await pub.readContract({ address: oldMarket, abi: artMarket.abi, functionName: "lp" });

const opSyBefore = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const opPtBefore = await pub.readContract({ address: oldPT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const opLpBefore = await pub.readContract({ address: oldLP, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`Pre-flight operator holdings:`);
console.log(`  SY:  ${opSyBefore}`);
console.log(`  PT (old): ${opPtBefore}  (keep — redeem at Aug 25 expiry)`);
console.log(`  LP (old): ${opLpBefore}  (100% of old pool — will drain)\n`);

if (opLpBefore > 0n) {
  console.log(`[1] OLD market.removeLiquidity(${opLpBefore})`);
  await send("removeLiquidity (old)", {
    account, address: oldMarket, abi: artMarket.abi, functionName: "removeLiquidity",
    args: [opLpBefore, 1n, 1n, account.address], gas: 4_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);
}

const EXPIRY = BigInt(dep.market.expiry);
const SCALAR_ROOT = BigInt("5000000000000000000");
const SUFFIX = `USDC-WHBAR-${new Date(Number(EXPIRY) * 1000).toISOString().slice(0, 10)}-anchor8`;
console.log(`\n[2] Factory.createRewardsMarket(suffix=${SUFFIX})`);
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

console.log(`[3] Periphery.registerMarket(newMarket)`);
await send("registerMarket", {
  account, address: periphery, abi: artPeriphery.abi, functionName: "registerMarket",
  args: [market], gas: 10_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

console.log(`\n[4a] shareToken.approve(newMarket, max)`);
await send("SY.approve(newMarket)", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await sleep(4000);

const opSyNow = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const half = opSyNow / 2n;
console.log(`[4b] newMarket.split(${half})`);
await send("split", {
  account, address: market, abi: artMarket.abi, functionName: "split",
  args: [half], gas: 4_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

const newPtBal = await pub.readContract({ address: newPT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`  → operator new-PT balance: ${newPtBal}\n`);

console.log(`[5a] newPT.approve(newMarket, max)`);
await send("PT.approve(newMarket)", {
  account, address: newPT, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await sleep(4000);

const SEED_SY = 10_000_000n;
const SEED_PT = 10_000_000n;
const ANCHOR = BigInt("1080000000000000000");
const LN_FEE = BigInt("10000000000000000");
const RESERVE = 50n;

console.log(`[5b] newMarket.initialize(${SEED_SY}, ${SEED_PT}, anchor=1.08e18, lnFee=0.01e18, reserve=50)`);
await send("initialize", {
  account, address: market, abi: artMarket.abi, functionName: "initialize",
  args: [SEED_SY, SEED_PT, ANCHOR, LN_FEE, RESERVE],
  gas: 4_000_000n, gasPrice: GAS_PRICE,
});
await sleep(8000);

const lnRate = await pub.readContract({ address: market, abi: artMarket.abi, functionName: "lastLnImpliedRate" });
const apyInit = (Math.exp(Number(lnRate)/1e18)-1)*100;
console.log(`  → initial lastLnImpliedRate: ${lnRate} (= ${apyInit.toFixed(2)}% APY)\n`);

const remainingSY = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const remainingPT = await pub.readContract({ address: newPT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`[6] Remaining for LP: SY=${remainingSY}  PT=${remainingPT}`);

const lpAmount = remainingSY < remainingPT ? remainingSY : remainingPT;
if (lpAmount > 1_000_000n) {
  console.log(`    market.addLiquidity(${lpAmount}, ${lpAmount}, 0, op)`);
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
console.log(`\nFinal new-market state:`);
console.log(`  lastLnImpliedRate: ${finalLnRate} (= ${finalApy.toFixed(2)}% APY)`);
console.log(`  totalSy: ${finalTotalSy}`);
console.log(`  totalPt: ${finalTotalPt}`);

dep.previousMarkets = dep.previousMarkets || [];
dep.previousMarkets.push({
  address: oldMarket,
  reason: "anchor=1.2e18 (20% APY) misconfigured; rebalance attempt drove it to 141% — replaced with anchor=1.08e18 (8% APY)",
  expiry: dep.market.expiry,
});
dep.market = {
  address: market,
  expiry: EXPIRY.toString(),
  scalarRoot: SCALAR_ROOT.toString(),
  suffix: SUFFIX,
  anchor: ANCHOR.toString(),
  anchorNote: "1.08e18 = 8% initial APY; matches observed SaucerSwap LP fee yield (~9.7% lifetime average)",
};
writeFileSync(join(REPO, "deployments/295.json"), JSON.stringify(dep, null, 2) + "\n");

console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`  ✅ New market: ${market}`);
console.log(`     Anchor: 1.08e18 (8% APY initial)`);
console.log(`     NEXT: update Vercel NEXT_PUBLIC_MARKET_ADDRESS to this address.`);
console.log(`══════════════════════════════════════════════════════════════════`);
