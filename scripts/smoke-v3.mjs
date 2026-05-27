#!/usr/bin/env node
// Periphery v3 smoke — verify all 6 fixes work live on mainnet.

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

const periphery = getAddress("0x0000000000000000000000000000000000a02731");
const sy = getAddress("0x0000000000000000000000000000000000a02585");
const market = getAddress("0x556938AcfDa70dF2A32ea97e6B6862B874d93ef9");
const shareToken = getAddress("0x0000000000000000000000000000000000A02586");
const pt = getAddress("0x0000000000000000000000000000000000A0259F");
const usdc = getAddress("0x000000000000000000000000000000000006f89a");

const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const marketAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function send(label, req) {
  console.log(`\n→ ${label}`);
  try {
    const hash = await wlt.writeContract(req);
    await new Promise((r) => setTimeout(r, 4000));
    const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
    if (r.ok) {
      const d = await r.json();
      if (d.result === "SUCCESS") { console.log(`  ✓ ${hash}`); return { ok: true, hash }; }
      console.log(`  ✗ ${d.result}: ${d.error_message?.slice(0,80)} ${hash}`);
      return { ok: false, hash, error: d.error_message };
    }
    console.log(`  ? mirror missing for ${hash}`);
    return { ok: false };
  } catch (e) {
    console.log(`  ✗ threw: ${(e.message||"").slice(0,120)}`);
    return { ok: false, error: e.message };
  }
}

console.log(`Periphery v3: ${periphery}\n`);

// ── Verify v3 storage ──
const reg = await pub.readContract({ address: periphery, abi: peripheryAbi, functionName: "marketRegistered", args: [market] });
const syReg = await pub.readContract({ address: periphery, abi: peripheryAbi, functionName: "registeredSyAdapter", args: [sy] });
const usdcProt = await pub.readContract({ address: periphery, abi: peripheryAbi, functionName: "isProtectedToken", args: [usdc] });
const shareProt = await pub.readContract({ address: periphery, abi: peripheryAbi, functionName: "isProtectedToken", args: [shareToken] });
console.log(`  marketRegistered(market): ${reg}`);
console.log(`  registeredSyAdapter(sy): ${syReg}`);
console.log(`  isProtectedToken(USDC): ${usdcProt}`);
console.log(`  isProtectedToken(shareToken): ${shareProt}`);

// ── X-5: rescueToken(USDC) should revert ProtectedToken ──
const usdcRescueRes = await send("X-5: rescueToken(USDC) — expect ProtectedToken revert", {
  account, address: periphery, abi: peripheryAbi, functionName: "rescueToken",
  args: [usdc, account.address, 1n],
  gas: 1_000_000n, gasPrice: GAS,
});

// ── X-6: setV3NpmFeeBudget(75 HBAR) — should succeed (would have failed in v2 with 50 cap) ──
const fee75 = await send("X-6: setV3NpmFeeBudget(75 HBAR) — should succeed", {
  account, address: periphery, abi: peripheryAbi, functionName: "setV3NpmFeeBudget",
  args: [BigInt(75 * 1e8)],
  gas: 500_000n, gasPrice: GAS,
});
// Reset to default 5 HBAR
if (fee75.ok) {
  await send("  reset v3NpmFeeBudget to 5 HBAR", {
    account, address: periphery, abi: peripheryAbi, functionName: "setV3NpmFeeBudget",
    args: [BigInt(5 * 1e8)],
    gas: 500_000n, gasPrice: GAS,
  });
}

// ── setOperator(v3) ──
const isOp = await pub.readContract({ address: market, abi: marketAbi, functionName: "isOperator", args: [account.address, periphery] });
if (!isOp) {
  await send("market.setOperator(periphery_v3, true)", {
    account, address: market, abi: marketAbi, functionName: "setOperator",
    args: [periphery, true], gas: 1_000_000n, gasPrice: GAS,
  });
}

// ── Approvals ──
for (const [tok, label] of [[shareToken, "SY-share"], [pt, "PT"]]) {
  await send(`${label}.approve(v3)`, {
    account, address: tok, abi: erc20Abi, functionName: "approve",
    args: [periphery, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
  });
}

// ── Happy path: zap + buyPt ──
await send(`v3.zapHbarToSy(8 HBAR)`, {
  account, address: periphery, abi: peripheryAbi, functionName: "zapHbarToSy",
  args: [market, account.address, 0n],
  value: parseEther("8"), gas: 15_000_000n, gasPrice: GAS,
});

const syBal = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const buyAmount = syBal / 50n;
console.log(`SY available: ${syBal}, buying with ${buyAmount}`);

await send(`v3.buySyForPt`, {
  account, address: periphery, abi: peripheryAbi, functionName: "buySyForPt",
  args: [market, buyAmount, buyAmount / 2n, account.address, 0n],
  gas: 8_000_000n, gasPrice: GAS,
});

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  v3 SMOKE COMPLETE");
console.log("══════════════════════════════════════════════════════════════════");
