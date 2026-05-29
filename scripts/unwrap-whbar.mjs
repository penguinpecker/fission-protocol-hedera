#!/usr/bin/env node
// unwrap-whbar.mjs — unwrap the operator's WHBAR back to native HBAR.
// WHBAR.withdraw requires an HTS allowance to the WHBAR contract first
// (mirrors FissionPeriphery: _ensureApproval(WHBAR, WHBAR_CONTRACT) then withdraw).
// DRY-RUN by default; pass --execute to broadcast. Env: NEW_DEPLOYER_KEY.

import { createPublicClient, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() {
  const p = join(REPO, ".env"); if (!existsSync(p)) return;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    const t = l.trim(); if (!t || t.startsWith("#")) continue;
    const e = t.indexOf("="); if (e < 0) continue;
    const k = t.slice(0, e).trim(); let v = t.slice(e + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const EXECUTE = process.argv.includes("--execute") || process.env.EXECUTE === "1";
const dep = JSON.parse(readFileSync(join(REPO, "deployments", "295.json"), "utf8"));
const WHBAR = getAddress(dep.external.WHBAR);              // HTS token (8-dec)
const WHBAR_CONTRACT = getAddress(dep.external.WHBAR_CONTRACT);
const INT64_MAX = (1n << 63n) - 1n;
const GAS_PRICE = 1_100_000_000_000n;
const MIRROR = "https://mainnet-public.mirrornode.hedera.com";

const KEY = (process.env.NEW_DEPLOYER_KEY || "").trim();
if (!KEY) throw new Error("NEW_DEPLOYER_KEY missing");
const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : "0x" + KEY);
const RPC = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
const chain = { id: 295, name: "Hedera Mainnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wlt = createWalletClient({ account, chain, transport: http(RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const whbarAbi = [
  { type: "function", name: "withdraw", inputs: [{ name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
];
const erc20Abi = [
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function mirrorTokenBal(token, holder) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}/tokens?token.id=0.0.${BigInt(token)}&limit=1`);
  if (!r.ok) return 0n; const j = await r.json(); return BigInt(j?.tokens?.[0]?.balance ?? 0);
}
async function mirrorHbar(holder) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}`); if (!r.ok) return 0n;
  return BigInt((await r.json())?.balance?.balance ?? 0); // tinybar
}
async function send(label, request) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(request);
  let result = null, err = null;
  for (let i = 0; i < 40; i++) { await sleep(2000);
    const r = await fetch(`${MIRROR}/api/v1/contracts/results/${hash}`);
    if (r.ok) { const j = await r.json(); if (j.result) { result = j.result; err = j.error_message; break; } } }
  if (result !== "SUCCESS") { if (err) console.error("  error:", err); throw new Error(`${label} -> ${result || "no receipt"}`); }
  console.log(`  ✓ ${hash} (${result})`); return hash;
}

(async () => {
  console.log(`══ Unwrap WHBAR → HBAR (mainnet) — ${EXECUTE ? "EXECUTE" : "DRY-RUN"} ══`);
  console.log(`  operator: ${account.address}`);
  const whbarBal = await mirrorTokenBal(WHBAR, account.address);
  const hbarBefore = await mirrorHbar(account.address);
  console.log(`  WHBAR balance: ${whbarBal} (8-dec = ${(Number(whbarBal) / 1e8).toFixed(4)} WHBAR)`);
  console.log(`  HBAR balance : ${(Number(hbarBefore) / 1e8).toFixed(4)}`);
  if (whbarBal === 0n) { console.log("  nothing to unwrap."); return; }

  if (!EXECUTE) {
    console.log(`\n  PLAN: approve(WHBAR → WHBAR_CONTRACT, int64.max), then WHBAR.withdraw(${whbarBal})`);
    console.log(`  → expect +${(Number(whbarBal) / 1e8).toFixed(4)} HBAR (minus gas). Re-run with --execute.`);
    return;
  }

  // allowance to WHBAR_CONTRACT already exists (int64.max) → withdraw directly,
  // minimizing the race window. withdraw() atomically pulls WHBAR + returns HBAR.
  await send(`WHBAR.withdraw(${whbarBal})`, {
    account, address: WHBAR_CONTRACT, abi: whbarAbi, functionName: "withdraw",
    args: [whbarBal], gas: 2_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);

  const whbarAfter = await mirrorTokenBal(WHBAR, account.address);
  const hbarAfter = await mirrorHbar(account.address);
  console.log(`\n  WHBAR: ${whbarBal} → ${whbarAfter}`);
  console.log(`  HBAR : ${(Number(hbarBefore) / 1e8).toFixed(4)} → ${(Number(hbarAfter) / 1e8).toFixed(4)}  (Δ ${((Number(hbarAfter) - Number(hbarBefore)) / 1e8).toFixed(4)})`);
  const gotHbar = hbarAfter > hbarBefore;
  console.log(whbarAfter === 0n && gotHbar ? `  ✅ Unwrapped to native HBAR.` : `  ⚠️ check: WHBAR left=${whbarAfter}, HBAR up=${gotHbar}`);

  // REVOKE the standing WHBAR allowance to the WHBAR contract so it can never be
  // pulled again (the ~$174 sweep used this allowance). Re-grant only when needed.
  await send(`REVOKE: approve(WHBAR → WHBAR_CONTRACT, 0)`, {
    account, address: WHBAR, abi: erc20Abi, functionName: "approve",
    args: [WHBAR_CONTRACT, 0n], gas: 1_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(6000);
  console.log(`\n✅ Done: remaining WHBAR unwrapped + WHBAR→WHBAR-contract allowance revoked (set to 0).`);
})();
