#!/usr/bin/env node
// Comprehensive Periphery v2 smoke — every leg, every edge case.

import { createPublicClient, createWalletClient, http, parseEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
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

const periphery = getAddress("0x0000000000000000000000000000000000a025c1");
const sy = getAddress("0x0000000000000000000000000000000000a02585");
const market = getAddress("0x556938AcfDa70dF2A32ea97e6B6862B874d93ef9");
const lens = getAddress("0xa1aAfc8C11A686a3Dee5DfE8B19D9eB43d321969");
const shareToken = getAddress("0x0000000000000000000000000000000000A02586");
const pt = getAddress("0x0000000000000000000000000000000000A0259F");
const lp = getAddress("0x0000000000000000000000000000000000A025A1");

const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const marketAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const lensAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionLens.sol/FissionLens.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

const results = [];

async function send(label, req, expectRevertSelector = null) {
  console.log(`\n→ ${label}`);
  try {
    const hash = await wlt.writeContract(req);
    await new Promise((r) => setTimeout(r, 4000));
    let status, err;
    try {
      const rec = await pub.waitForTransactionReceipt({ hash });
      status = rec.status; err = null;
    } catch {
      const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
      if (r.ok) { const d = await r.json(); status = d.result === "SUCCESS" ? "success" : "reverted"; err = d.error_message; }
    }
    if (status === "success") {
      if (expectRevertSelector) {
        console.log(`  ⚠ EXPECTED REVERT(${expectRevertSelector}) but succeeded: ${hash}`);
        results.push({ label, ok: false, reason: "expected revert but succeeded" });
      } else {
        console.log(`  ✓ ${hash}`);
        results.push({ label, ok: true });
      }
    } else {
      if (expectRevertSelector && err && err.toLowerCase().includes(expectRevertSelector.toLowerCase())) {
        console.log(`  ✓ correctly reverted (selector match): ${hash}`);
        results.push({ label, ok: true, reverted: true });
      } else if (expectRevertSelector) {
        console.log(`  ⚠ reverted but wrong selector. error=${(err||"").slice(0,80)} hash=${hash}`);
        results.push({ label, ok: false, reason: `unexpected error: ${err}` });
      } else {
        console.log(`  ✗ ${err||"reverted"}: ${hash}`);
        results.push({ label, ok: false, reason: err });
      }
    }
  } catch (e) {
    console.log(`  ✗ threw: ${(e.message||"").slice(0,120)}`);
    results.push({ label, ok: false, reason: e.message });
  }
}

console.log(`Periphery v2: ${periphery}`);
console.log(`Operator:     ${account.address}`);
console.log(`HBAR:         ${(Number(await pub.getBalance({ address: account.address })) / 1e18).toFixed(2)}\n`);

// One-time setup
for (const [tok, label] of [[shareToken, "SY-share"], [pt, "PT"], [lp, "LP"]]) {
  await send(`${label}.approve(v2)`, {
    account, address: tok, abi: erc20Abi, functionName: "approve",
    args: [periphery, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
  });
}

// ── Test 1: unzapSyToHbar with UNREGISTERED adapter (proper 20-byte address) ──
await send("unzapSyToHbar(UNREGISTERED=0xdead...0001) — expect UnregisteredSyAdapter", {
  account, address: periphery, abi: peripheryAbi, functionName: "unzapSyToHbar",
  args: ["0x000000000000000000000000000000000000dead", 100n, 1n, 0n],
  gas: 2_000_000n, gasPrice: GAS,
}, "unregistered");

// ── Test 2: buySyForPt with Lens-quoted minPtOut ──
const syBal = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`\nSY balance: ${syBal}`);
const buyAmount = syBal / 50n;  // 2% of holdings
if (buyAmount > 0n) {
  await send(`v2.buySyForPt(syIn=${buyAmount}, minPtOut=${buyAmount/2n})`, {
    account, address: periphery, abi: peripheryAbi, functionName: "buySyForPt",
    args: [market, buyAmount, buyAmount / 2n, account.address, 0n],
    gas: 8_000_000n, gasPrice: GAS,
  });
}

// ── Test 3: buySyForYt ──
if (buyAmount > 0n) {
  await send(`v2.buySyForYt(syIn=${buyAmount}, minSyOut=1)`, {
    account, address: periphery, abi: peripheryAbi, functionName: "buySyForYt",
    args: [market, buyAmount, 1n, account.address, 0n],
    gas: 10_000_000n, gasPrice: GAS,
  });
}

// ── Test 4: buySyForLp with Lens-quoted ptOutFromSwap ──
if (buyAmount > 0n) {
  // Compute ptOutFromSwap: half budget → ~half * 1/0.83 (PT discounted)
  // Use Lens preview: ask Lens "how much SY for ptOut PT"? Inverse.
  // Easier: pass a tight ptOut = budget/2 (50/50 split: half SY for swap, want PT ~ half SY worth).
  const ptOutFromSwap = (buyAmount / 2n) * 9n / 10n; // expect ~90% efficiency
  await send(`v2.buySyForLp(syIn=${buyAmount}, ptShareBps=5000, ptOutFromSwap=${ptOutFromSwap})`, {
    account, address: periphery, abi: peripheryAbi, functionName: "buySyForLp",
    args: [market, buyAmount, 5000, ptOutFromSwap, 1n, account.address, 0n],
    gas: 12_000_000n, gasPrice: GAS,
  });
}

// ── Test 5: sellPtForSy ──
const ptBal = await pub.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`\nPT balance: ${ptBal}`);
const totalPt = await pub.readContract({ address: market, abi: marketAbi, functionName: "totalPt" });
const sellCap = (totalPt * 4n) / 100n;
const sellPt = ptBal < sellCap ? ptBal / 2n : sellCap;
if (sellPt > 1n) {
  await send(`v2.sellPtForSy(${sellPt})`, {
    account, address: periphery, abi: peripheryAbi, functionName: "sellPtForSy",
    args: [market, sellPt, 1n, account.address, 0n],
    gas: 8_000_000n, gasPrice: GAS,
  });
}

// ── Test 6: sellYtForSy (needs setOperator — already true) ──
const ytBal = await pub.readContract({ address: market, abi: marketAbi, functionName: "ytBalanceOf", args: [account.address] });
console.log(`\nYT balance: ${ytBal}`);
const sellYt = ytBal < sellCap ? ytBal / 4n : sellCap;
if (sellYt > 1n) {
  await send(`v2.sellYtForSy(${sellYt})`, {
    account, address: periphery, abi: peripheryAbi, functionName: "sellYtForSy",
    args: [market, sellYt, 1n, account.address, 0n],
    gas: 8_000_000n, gasPrice: GAS,
  });
}

// ── Test 7: sellLpForSy ──
const lpBal = await pub.readContract({ address: lp, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`\nLP balance: ${lpBal}`);
const lpTotalSupply = await pub.readContract({ address: lp, abi: erc20Abi, functionName: "totalSupply" }).catch(() => null);
const lpCap = lpTotalSupply ? (lpTotalSupply * 4n) / 100n : lpBal;
const sellLp = lpBal < lpCap ? lpBal / 4n : lpCap;
if (sellLp > 1n) {
  await send(`v2.sellLpForSy(${sellLp} of ${lpBal})`, {
    account, address: periphery, abi: peripheryAbi, functionName: "sellLpForSy",
    args: [market, sellLp, 1n, account.address, 0n],
    gas: 10_000_000n, gasPrice: GAS,
  });
}

// ── Test 8: unzapSyToHbar with REGISTERED + final SY balance ──
const finalSy = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const finalUnzap = finalSy / 100n;
if (finalUnzap > 0n) {
  await send(`v2.unzapSyToHbar(REGISTERED, ${finalUnzap})`, {
    account, address: periphery, abi: peripheryAbi, functionName: "unzapSyToHbar",
    args: [sy, finalUnzap, 1n, 0n],
    gas: 10_000_000n, gasPrice: GAS,
  });
}

// ── Summary ──
console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  V2 FULL SMOKE SUMMARY");
console.log("══════════════════════════════════════════════════════════════════");
let pass = 0, fail = 0;
for (const r of results) {
  const sym = r.ok ? "✓" : "✗";
  console.log(`  ${sym}  ${r.label}${r.reason ? "  — " + r.reason.slice(0,80) : ""}`);
  r.ok ? pass++ : fail++;
}
console.log(`\nTotal: ${pass} pass / ${fail} fail`);
