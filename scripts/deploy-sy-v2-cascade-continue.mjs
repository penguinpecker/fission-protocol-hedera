#!/usr/bin/env node
// Continue X-2 cascade from createRewardsMarket. Previous run completed:
//   ✓ deploy new SY at 0x...a0289a
//   ✓ initShareToken (shareToken = 0x...a0289b)
//   ✓ proposeSY + confirmSY (whitelistedSY = true)
// Remaining:
//   - createRewardsMarket → registerMarket → setOperator → fund

import { createPublicClient, createWalletClient, http, parseEther, getAddress, decodeEventLog } from "viem";
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
const GAS = 1_100_000_000_000n;

const sy = getAddress("0x0000000000000000000000000000000000a0289a");
const shareToken = getAddress("0x0000000000000000000000000000000000a0289b");
const factory = getAddress("0x799549F698bBBAc90B9e1C37eF3946A1A1d3397c");
const periphery = getAddress("0x0000000000000000000000000000000000a02731");

const artFactory = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionFactory.sol/FissionFactory.json"), "utf8"));
const artPeriphery = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8"));
const artMarket = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function vsend(label, req) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(req);
  await new Promise((r) => setTimeout(r, 8000));
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
  if (!r.ok) throw new Error(`${label} mirror ${r.status}`);
  const d = await r.json();
  if (d.result !== "SUCCESS") throw new Error(`${label} ${d.result}: ${d.error_message}`);
  console.log(`  ✓ ${hash}`);
  return { hash, receipt: d };
}

console.log(`Balance: ${(Number(await pub.getBalance({ address: account.address })) / 1e18).toFixed(2)} HBAR\n`);

// ── 1. createRewardsMarket ──
const EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 86400 * 90);
const SCALAR = BigInt("5000000000000000000");
const SUFFIX = `USDC-WHBAR-${new Date(Number(EXPIRY) * 1000).toISOString().slice(0, 10)}-v3`;
console.log(`createRewardsMarket suffix=${SUFFIX}`);
const cmHash = await wlt.writeContract({
  account, address: factory, abi: artFactory.abi, functionName: "createRewardsMarket",
  args: [sy, EXPIRY, SCALAR, SUFFIX],
  value: parseEther("60"), gas: 14_000_000n, gasPrice: GAS,
});
console.log(`  tx: ${cmHash}`);
await new Promise((r) => setTimeout(r, 10000));
const rec = await pub.getTransactionReceipt({ hash: cmHash });
if (rec.status !== "success") throw new Error(`createRewardsMarket reverted`);

let market = null;
for (const log of rec.logs) {
  try {
    const evt = decodeEventLog({ abi: artFactory.abi, data: log.data, topics: log.topics });
    if (evt.eventName === "MarketCreated") { market = evt.args.market; break; }
  } catch {}
}
if (!market) throw new Error("MarketCreated event missing");
console.log(`  Market: ${market}\n`);

// ── 2. registerMarket on Periphery v3 ──
await vsend("Periphery.registerMarket(newMarket)", {
  account, address: periphery, abi: artPeriphery.abi, functionName: "registerMarket",
  args: [market], gas: 10_000_000n, gasPrice: GAS,
});

// ── 3. setOperator on new market for Periphery v3 ──
await vsend("market.setOperator(periphery_v3, true)", {
  account, address: market, abi: artMarket, functionName: "setOperator",
  args: [periphery, true], gas: 1_000_000n, gasPrice: GAS,
});

// ── 4. Fund: zapHbarToSy(~1500 HBAR — leave some headroom for ops) ──
const pt = await pub.readContract({ address: market, abi: artMarket, functionName: "pt" });
console.log(`PT: ${pt}\n`);

const syBalBefore = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const FUND_HBAR = process.env.FUND_HBAR || "800";
await vsend(`Periphery.zapHbarToSy(${FUND_HBAR} HBAR)`, {
  account, address: periphery, abi: artPeriphery.abi, functionName: "zapHbarToSy",
  args: [market, account.address, 0n],
  value: parseEther(FUND_HBAR), gas: 15_000_000n, gasPrice: GAS,
});
const syBalAfter = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const syReceived = syBalAfter - syBalBefore;
console.log(`SY received: ${syReceived}\n`);

await vsend("SY.approve(newMarket)", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

const halfSy = syReceived / 2n;
const remainingSy = syReceived - halfSy;
await vsend(`Market.split(${halfSy})`, {
  account, address: market, abi: artMarket, functionName: "split",
  args: [halfSy], gas: 4_000_000n, gasPrice: GAS,
});

const ptBal = await pub.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
await vsend("PT.approve(newMarket)", {
  account, address: pt, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

// Initialize with ~10% of budget; addLiquidity for rest.
const initSy = remainingSy / 10n;
const initPt = ptBal / 10n;
const ANCHOR = BigInt("1200000000000000000");
const LN_FEE = BigInt("10000000000000000");
const RESERVE = 50n;
await vsend(`Market.initialize(${initSy}, ${initPt}, anchor=1.2e18)`, {
  account, address: market, abi: artMarket, functionName: "initialize",
  args: [initSy, initPt, ANCHOR, LN_FEE, RESERVE],
  gas: 4_000_000n, gasPrice: GAS,
});

const moreSy = remainingSy - initSy;
const morePt = ptBal - initPt;
await vsend(`Market.addLiquidity(${moreSy}, ${morePt}) — deepen`, {
  account, address: market, abi: artMarket, functionName: "addLiquidity",
  args: [moreSy, morePt, 1n, account.address],
  gas: 6_000_000n, gasPrice: GAS,
});

// ── Persist ──
const out = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
out.previousSY = out.contracts.saucerSwapLPYieldSource;
out.previousMarket = out.market.address;
out.contracts.saucerSwapLPYieldSource = sy;
out.market = { address: market, expiry: EXPIRY.toString(), scalarRoot: SCALAR.toString(), suffix: SUFFIX, anchor: "1.2e18" };
out.xFixes_2_10_cascade = {
  ts: new Date().toISOString(),
  newSy: sy, newMarket: market,
  oldSy: out.previousSY, oldMarket: out.previousMarket,
  reason: "X-2 / X-10 fix: SY adapter now has sweepHbar() + receive() so stuck HBAR is recoverable.",
};
writeFileSync(join(REPO, "deployments/295.json"), JSON.stringify(out, null, 2) + "\n");

const totalPt = await pub.readContract({ address: market, abi: artMarket, functionName: "totalPt" });
const totalSy = await pub.readContract({ address: market, abi: artMarket, functionName: "totalSy" });
console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`  ✅ Cascade complete`);
console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  New SY:      ${sy}`);
console.log(`  New Market:  ${market}`);
console.log(`  Pool depth:  totalPt=${totalPt}  totalSy=${totalSy}`);
