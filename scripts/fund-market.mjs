#!/usr/bin/env node
// Deepen the market liquidity to ~1k HBAR per side so the dApp is actually
// usable. Flow:
//   1. Periphery.zapHbarToSy(2000 HBAR) -> ~2000 HBAR worth of SY shares
//   2. SY.approve(market, max int64)
//   3. Market.split(half of SY) -> half PT + half YT to operator
//   4. PT.approve(market, max int64)
//   5. Market.addLiquidity(remaining SY, half PT, minLpOut=1, operator)
//
// Operator keeps the YT from the split; the pool gets ~1k HBAR worth on each side.

import { createPublicClient, createWalletClient, http, parseEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
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
const GAS = 1_100_000_000_000n;

const dep = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
const periphery = getAddress(dep.contracts.periphery);   // v2
const sy = getAddress(dep.contracts.saucerSwapLPYieldSource);
const market = getAddress(dep.market.address);
const FUND_HBAR = process.env.FUND_HBAR || "2000";

const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const marketAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const syAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

console.log(`Funding market with ${FUND_HBAR} HBAR via Periphery v2`);
console.log(`  Periphery: ${periphery}`);
console.log(`  SY:        ${sy}`);
console.log(`  Market:    ${market}`);
console.log(`  Balance:   ${(Number(await pub.getBalance({ address: account.address })) / 1e18).toFixed(2)} HBAR\n`);

const shareToken = await pub.readContract({ address: sy, abi: syAbi, functionName: "shareToken" });
const pt = await pub.readContract({ address: market, abi: marketAbi, functionName: "pt" });

async function send(label, req) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(req);
  const rec = await pub.waitForTransactionReceipt({ hash });
  if (rec.status !== "success") {
    const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
    if (r.ok) console.error("error:", (await r.json()).error_message);
    throw new Error(`${label} reverted`);
  }
  console.log(`  ✓ ${hash}`);
}

const sySnap1 = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

// 1. Zap HBAR -> SY
await send(`Periphery.zapHbarToSy(${FUND_HBAR} HBAR)`, {
  account, address: periphery, abi: peripheryAbi, functionName: "zapHbarToSy",
  args: [market, account.address, 0n],
  value: parseEther(FUND_HBAR), gas: 15_000_000n, gasPrice: GAS,
});

const sySnap2 = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const syReceived = sySnap2 - sySnap1;
console.log(`  SY received: ${syReceived}\n`);

// 2. Approve SY -> market
await send("SY.approve(market)", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

// 3. Split half
const halfSy = syReceived / 2n;
const remainingSy = syReceived - halfSy;
await send(`Market.split(${halfSy})`, {
  account, address: market, abi: marketAbi, functionName: "split",
  args: [halfSy], gas: 4_000_000n, gasPrice: GAS,
});

const ptBal = await pub.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`  PT balance: ${ptBal}\n`);

// 4. Approve PT -> market (idempotent — likely already approved)
await send("PT.approve(market)", {
  account, address: pt, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

// 5. addLiquidity with remainingSy + ptBal (the half we just received)
const ptForLp = ptBal > remainingSy ? remainingSy : ptBal; // proportional cap
await send(`Market.addLiquidity(syIn=${remainingSy}, ptIn=${ptForLp})`, {
  account, address: market, abi: marketAbi, functionName: "addLiquidity",
  args: [remainingSy, ptForLp, 1n, account.address],
  gas: 4_000_000n, gasPrice: GAS,
});

// Snapshot post-fund pool depth
const totalPt = await pub.readContract({ address: market, abi: marketAbi, functionName: "totalPt" });
const totalSy = await pub.readContract({ address: market, abi: marketAbi, functionName: "totalSy" });
console.log(`\n✅ Pool depth now:`);
console.log(`   totalPt: ${totalPt}`);
console.log(`   totalSy: ${totalSy}`);
