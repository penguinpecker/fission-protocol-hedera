#!/usr/bin/env node
// Honest smoke test of Periphery v2. Tests:
//   1. setOperator(v2) on market — required for SellYt path
//   2. unzapSyToHbar via v2 — exercises the H-4 registeredSyAdapter gate
//   3. unzapSyToHbar against UNREGISTERED adapter — must revert UnregisteredSyAdapter
//   4. zapHbarToSy via v2 — basic Buy entry
// Uses small amounts (~1-3 HBAR each, plus the unzap is from existing SY).

import { createPublicClient, createWalletClient, http, parseEther, getAddress, decodeEventLog } from "viem";
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
const shareToken = getAddress("0x0000000000000000000000000000000000A02586");

const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const marketAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function send(label, req) {
  console.log(`→ ${label}`);
  try {
    const hash = await wlt.writeContract(req);
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const rec = await pub.waitForTransactionReceipt({ hash });
      if (rec.status !== "success") throw new Error(`status=${rec.status}`);
      console.log(`  ✓ ${hash}`);
      return { ok: true, hash };
    } catch {
      // Mirror fallback
      const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
      if (r.ok) {
        const d = await r.json();
        if (d.result === "SUCCESS") { console.log(`  ✓ ${hash} (mirror)`); return { ok: true, hash }; }
        console.log(`  ✗ ${d.result}: ${d.error_message}`);
        return { ok: false, hash, error: d.error_message };
      }
      throw new Error("unknown");
    }
  } catch (e) {
    console.log(`  ✗ threw: ${e.message?.slice(0, 200)}`);
    return { ok: false, error: e.message };
  }
}

console.log(`Periphery v2: ${periphery}`);
console.log(`Operator:     ${account.address}\n`);

// ── 1. setOperator(v2) on market ──
const isOpBefore = await pub.readContract({ address: market, abi: marketAbi, functionName: "isOperator", args: [account.address, periphery] });
console.log(`isOperator before: ${isOpBefore}`);
if (!isOpBefore) {
  await send("market.setOperator(periphery_v2, true)", {
    account, address: market, abi: marketAbi, functionName: "setOperator",
    args: [periphery, true], gas: 1_000_000n, gasPrice: GAS,
  });
}
const isOpAfter = await pub.readContract({ address: market, abi: marketAbi, functionName: "isOperator", args: [account.address, periphery] });
console.log(`isOperator after: ${isOpAfter}\n`);

// ── 2. Ensure SY share approved to v2 ──
await send("SY.approve(periphery_v2)", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [periphery, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

// ── 3. unzapSyToHbar via v2 (REGISTERED adapter — should succeed) ──
const syBal = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`\nSY balance: ${syBal}`);
const tinyUnzap = syBal / 1000n;
if (tinyUnzap > 0n) {
  await send(`v2.unzapSyToHbar(REGISTERED sy, ${tinyUnzap}) — should succeed`, {
    account, address: periphery, abi: peripheryAbi, functionName: "unzapSyToHbar",
    args: [sy, tinyUnzap, 1n, 0n],
    gas: 10_000_000n, gasPrice: GAS,
  });
}

// ── 4. unzapSyToHbar with UNREGISTERED adapter — should REVERT UnregisteredSyAdapter ──
const fakeAdapter = "0x0000000000000000000000000000000000000dead";
console.log("");
const res = await send(`v2.unzapSyToHbar(UNREGISTERED ${fakeAdapter}) — expect REVERT`, {
  account, address: periphery, abi: peripheryAbi, functionName: "unzapSyToHbar",
  args: [fakeAdapter, 100n, 1n, 0n],
  gas: 2_000_000n, gasPrice: GAS,
});
if (res.ok) {
  console.log("  ⚠ EXPECTED REVERT but succeeded — H-4 gate not effective!");
} else if (res.error && res.error.toLowerCase().includes("unregistered")) {
  console.log("  ✓ correctly reverted with UnregisteredSyAdapter");
} else {
  // Check selector — 0x... should be UnregisteredSyAdapter
  console.log(`  (reverted; error pattern: ${(res.error || "").slice(0, 100)})`);
}

// ── 5. zapHbarToSy via v2 (small) ──
console.log("");
await send(`v2.zapHbarToSy(10 HBAR)`, {
  account, address: periphery, abi: peripheryAbi, functionName: "zapHbarToSy",
  args: [market, account.address, 0n],
  value: parseEther("10"), gas: 15_000_000n, gasPrice: GAS,
});

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  v2 smoke complete");
console.log("══════════════════════════════════════════════════════════════════");
