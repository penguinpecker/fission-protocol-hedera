#!/usr/bin/env node
// Operator-only seed flow for the clean-slate rebuild.
//
// Step A: Zap HBAR → SY shares via Periphery (creates V3 NFT on first call).
// Step B: Approve SY share → Market, split into PT+YT.
// Step C: Approve PT → Market, market.initialize(syIn, ptIn, anchor, fee, reserve).
//
// Run AFTER scripts/deploy-rebuild.mjs. Reads deployments/295.json.
//
// Env:
//   NEW_DEPLOYER_KEY        ECDSA hex (required)
//   SEED_HBAR              HBAR amount to seed (default 60 — gives ~30 HBAR per side)

import {
  createPublicClient, createWalletClient, http, parseEther, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

function loadDotenv() {
  const p = join(REPO, ".env");
  if (!existsSync(p)) return;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const e = t.indexOf("=");
    if (e < 0) continue;
    const k = t.slice(0, e).trim();
    let v = t.slice(e + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const dep = JSON.parse(readFileSync(join(REPO, "deployments", "295.json"), "utf8"));
const PERIPHERY = getAddress(dep.contracts.periphery);
const SY = getAddress(dep.contracts.saucerSwapLPYieldSource);
const MARKET = getAddress(dep.market.address);

const KEY = (process.env.NEW_DEPLOYER_KEY || "").trim();
if (!KEY) throw new Error("NEW_DEPLOYER_KEY missing in .env");
const PK = KEY.startsWith("0x") ? KEY : "0x" + KEY;
const account = privateKeyToAccount(PK);

const SEED_HBAR = parseEther(process.env.SEED_HBAR || "100");
const RPC = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
const chain = { id: 295, name: "Hedera Mainnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wlt = createWalletClient({ account, chain, transport: http(RPC) });
const GAS_PRICE = 1_100_000_000_000n;

// Minimal ABIs for the calls we need.
const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const marketAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];
const syAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8")).abi;
const shareToken = await pub.readContract({ address: SY, abi: syAbi, functionName: "shareToken" });
const pt = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "pt" });
console.log(`Seeding: SY=${SY}  Market=${MARKET}  shareToken=${shareToken}  PT=${pt}`);

async function send(label, request) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(request);
  const rec = await pub.waitForTransactionReceipt({ hash });
  if (rec.status !== "success") throw new Error(`${label} reverted`);
  console.log(`  ✓ ${hash}`);
  return rec;
}

// ── A: Zap HBAR → SY (creates V3 NFT) ──
const balBefore = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
await send("Periphery.zapHbarToSy", {
  account, address: PERIPHERY, abi: peripheryAbi, functionName: "zapHbarToSy",
  args: [MARKET, account.address, 0n],
  value: SEED_HBAR, gas: 15_000_000n, gasPrice: GAS_PRICE,
});
const balAfter = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const sySeeded = balAfter - balBefore;
console.log(`  SY shares received: ${sySeeded}`);

// ── B: Approve SY share → Market, split half → PT/YT ──
const sySplit = sySeeded / 2n;
const syForInit = sySeeded - sySplit;
await send("SY.approve(market)", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [MARKET, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await send("Market.split", {
  account, address: MARKET, abi: marketAbi, functionName: "split",
  args: [sySplit], gas: 4_000_000n, gasPrice: GAS_PRICE,
});

// ── C: Approve PT → Market, market.initialize ──
const ptBal = await pub.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`  PT minted: ${ptBal}`);

await send("PT.approve(market)", {
  account, address: pt, abi: erc20Abi, functionName: "approve",
  args: [MARKET, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS_PRICE,
});

// Pendle V2 initial anchor: ln(1 + apy) * IMPLIED_RATE_TIME / 365 days. For a
// reasonable starting APY of ~10%, anchor ≈ 0.0953e18.
const INITIAL_ANCHOR = BigInt(process.env.INITIAL_ANCHOR || "1000000000000000000"); // 1e18 (≈ 0% APY anchor)
const LN_FEE_ROOT = BigInt(process.env.LN_FEE_ROOT || "10000000000000000"); // 0.01e18
const RESERVE_FEE = BigInt(process.env.RESERVE_FEE || "50"); // 50%

await send("Market.initialize", {
  account, address: MARKET, abi: marketAbi, functionName: "initialize",
  args: [syForInit, ptBal, INITIAL_ANCHOR, LN_FEE_ROOT, RESERVE_FEE],
  gas: 4_000_000n, gasPrice: GAS_PRICE,
});

console.log(`\n✅ Market seeded.`);
console.log(`   SY in pool : ${syForInit}`);
console.log(`   PT in pool : ${ptBal}`);
console.log(`   YT held by operator: ${sySplit}`);
console.log(`\nNext: run scripts/smoke-rebuild.mjs to verify each Periphery leg.`);
