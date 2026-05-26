#!/usr/bin/env node
// End-to-end smoke test for the clean-slate rebuild.
// Runs one small trade per Periphery leg from the operator wallet.
// Prints HashScan URLs + child-record counts for each tx.
//
// Run AFTER scripts/deploy-rebuild.mjs + scripts/seed-rebuild.mjs.

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

const RPC = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
const chain = { id: 295, name: "Hedera Mainnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wlt = createWalletClient({ account, chain, transport: http(RPC) });
const GAS_PRICE = 1_100_000_000_000n;

const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const marketAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const syAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

const shareToken = await pub.readContract({ address: SY, abi: syAbi, functionName: "shareToken" });
const pt = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "pt" });
const lp = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "lp" });
console.log(`Targets: PERIPHERY=${PERIPHERY} SY=${SY} MARKET=${MARKET}`);
console.log(`         shareToken=${shareToken} PT=${pt} LP=${lp}\n`);

const results = [];

async function attempt(label, fn) {
  console.log(`\n══════ ${label} ══════`);
  try {
    const hash = await fn();
    const rec = await pub.waitForTransactionReceipt({ hash });
    const status = rec.status;
    console.log(`  status: ${status}  tx: ${hash}`);
    console.log(`  hashscan: https://hashscan.io/mainnet/transaction/${hash}`);
    // Pull child record count from mirror node.
    let childCount = null;
    try {
      // Mirror is slightly behind; one quick retry.
      for (let i = 0; i < 6; i++) {
        const tx = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
        if (tx.ok) {
          const j = await tx.json();
          if (j.timestamp) {
            const child = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/transactions?timestamp=${j.timestamp}`);
            if (child.ok) {
              const cj = await child.json();
              if (cj.transactions) {
                childCount = cj.transactions.length;
                break;
              }
            }
          }
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch {}
    if (childCount !== null) console.log(`  child records: ${childCount} / 50`);
    results.push({ label, status, hash, childCount });
    return rec;
  } catch (e) {
    console.error(`  ✗ ${label} FAILED: ${e.message}`);
    results.push({ label, status: "failed", error: e.message });
    return null;
  }
}

// One-time setup: approve SY share, PT, LP to periphery (operator does this once).
async function ensureApproved(token, label) {
  console.log(`→ Approving ${label} → Periphery`);
  const hash = await wlt.writeContract({
    account, address: token, abi: erc20Abi, functionName: "approve",
    args: [PERIPHERY, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS_PRICE,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`  ✓`);
}
await ensureApproved(shareToken, "SY-share");
await ensureApproved(pt, "PT");
await ensureApproved(lp, "LP");

// Also: setOperator on market for YT-sell.
const setOpHash = await wlt.writeContract({
  account, address: MARKET, abi: marketAbi, functionName: "setOperator",
  args: [PERIPHERY, true], gas: 1_000_000n, gasPrice: GAS_PRICE,
});
await pub.waitForTransactionReceipt({ hash: setOpHash });
console.log(`→ market.setOperator(periphery, true): ${setOpHash}\n`);

// ── BUY flow ──
await attempt("Tx1: zapHbarToSy(15 HBAR)", async () =>
  wlt.writeContract({
    account, address: PERIPHERY, abi: peripheryAbi, functionName: "zapHbarToSy",
    args: [MARKET, account.address, 0n],
    value: parseEther("15"), gas: 15_000_000n, gasPrice: GAS_PRICE,
  })
);

// Read SY share balance and use small amount for next tx.
const syBal = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const buyAmount = syBal / 100n; // 1% of what we just got
console.log(`\n  SY available: ${syBal}, using ${buyAmount} for next legs`);

// Query Lens for the actual PT we'd get out of the curve, then use 99% of that.
const lensAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionLens.sol/FissionLens.json"), "utf8")).abi;
const LENS = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8")).contracts.lens;
// Lens has previewSwapExactSyForPt(market, ptOut) — solve inverse via binary search/heuristic.
// Easier: just buy a tiny amount the curve clearly accepts.
const minPtOut = buyAmount / 2n; // for PT at ~0.83 discount, buyAmount SY gets you ~buyAmount/0.83 PT, but to be safe ask for less
await attempt(`Tx2: buySyForPt(syIn=${buyAmount}, minPtOut=${minPtOut})`, async () =>
  wlt.writeContract({
    account, address: PERIPHERY, abi: peripheryAbi, functionName: "buySyForPt",
    args: [MARKET, buyAmount, minPtOut, account.address, 0n],
    gas: 8_000_000n, gasPrice: GAS_PRICE,
  })
);

await attempt(`Tx2-alt: buySyForYt(${buyAmount})`, async () =>
  wlt.writeContract({
    account, address: PERIPHERY, abi: peripheryAbi, functionName: "buySyForYt",
    args: [MARKET, buyAmount, 1n, account.address, 0n],
    gas: 10_000_000n, gasPrice: GAS_PRICE,
  })
);

// buySyForLp: minLpOut needs to be realistic too. With 1% pool budget split 50/50,
// we'd add ~buyAmount/2 SY + ~buyAmount/2 PT → mint ~buyAmount/2 LP. Ask for half.
const minLpOut = buyAmount / 4n;
await attempt(`Tx2-alt: buySyForLp(syIn=${buyAmount}, minLpOut=${minLpOut})`, async () =>
  wlt.writeContract({
    account, address: PERIPHERY, abi: peripheryAbi, functionName: "buySyForLp",
    args: [MARKET, buyAmount, 5000, minLpOut, account.address, 0n],
    gas: 10_000_000n, gasPrice: GAS_PRICE,
  })
);

// ── SELL flow ──  (all amounts capped to 4% of pool depth — under the 5% Periphery cap)
const totalPt = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "totalPt" });
const lpTotal = await pub.readContract({ address: lp, abi: erc20Abi, functionName: "totalSupply" });
const sellCap = (totalPt * 4n) / 100n; // 4% of pool depth
const lpCap = (lpTotal * 4n) / 100n;

const ptBal = await pub.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if (ptBal > 1n) {
  const sellAmount = ptBal < sellCap ? ptBal : sellCap;
  await attempt(`Tx1: sellPtForSy(${sellAmount})`, async () =>
    wlt.writeContract({
      account, address: PERIPHERY, abi: peripheryAbi, functionName: "sellPtForSy",
      args: [MARKET, sellAmount, 1n, account.address, 0n],
      gas: 8_000_000n, gasPrice: GAS_PRICE,
    })
  );
}

const lpBal = await pub.readContract({ address: lp, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if (lpBal > 1n) {
  const sellLpAmount = lpBal < lpCap ? lpBal : lpCap;
  await attempt(`Tx1: sellLpForSy(${sellLpAmount} of ${lpBal})`, async () =>
    wlt.writeContract({
      account, address: PERIPHERY, abi: peripheryAbi, functionName: "sellLpForSy",
      args: [MARKET, sellLpAmount, 1n, account.address, 0n],
      gas: 10_000_000n, gasPrice: GAS_PRICE,
    })
  );
}

const ytBal = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "ytBalanceOf", args: [account.address] });
if (ytBal > 1n) {
  const sellYt = ytBal < sellCap ? ytBal : sellCap;
  await attempt(`Tx1: sellYtForSy(${sellYt} of ${ytBal})`, async () =>
    wlt.writeContract({
      account, address: PERIPHERY, abi: peripheryAbi, functionName: "sellYtForSy",
      args: [MARKET, sellYt, 1n, account.address, 0n],
      gas: 8_000_000n, gasPrice: GAS_PRICE,
    })
  );
}

const finalSy = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if (finalSy > 1n) {
  const unzapAmount = finalSy / 4n;
  await attempt(`Tx2: unzapSyToHbar(${unzapAmount})`, async () =>
    wlt.writeContract({
      account, address: PERIPHERY, abi: peripheryAbi, functionName: "unzapSyToHbar",
      args: [SY, unzapAmount, 1n, 0n],
      gas: 10_000_000n, gasPrice: GAS_PRICE,
    })
  );
}

// ── Summary ──
console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  Smoke Summary");
console.log("══════════════════════════════════════════════════════════════════");
for (const r of results) {
  const symbol = r.status === "success" ? "✓" : "✗";
  const child = r.childCount !== null ? `${r.childCount}/50` : "n/a";
  console.log(`  ${symbol}  ${r.label.padEnd(45)} children=${child}`);
}

const maxChild = Math.max(...results.filter(r => r.childCount !== null).map(r => r.childCount));
if (maxChild >= 50) {
  console.log(`\n  ⚠️  ${results.filter(r => r.childCount >= 50).length} leg(s) at the 50-child cap. Frontend must not chain >1 such tx per user submit.`);
} else if (maxChild >= 35) {
  console.log(`\n  ⚠️  Worst leg uses ${maxChild}/50 children. Acceptable but tighten if any leg gains hops.`);
} else {
  console.log(`\n  ✅ All legs comfortably under cap (worst = ${maxChild}/50).`);
}
