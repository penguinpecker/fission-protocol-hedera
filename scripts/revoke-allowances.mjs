#!/usr/bin/env node
// revoke-allowances.mjs — revoke ALL standing HTS token allowances on the deployer
// wallet (a leftover risk surface; the 2026-05-29 WHBAR sweep used one). The operator
// needs no standing allowances — re-grant per-use. DRY-RUN default; --execute to revoke.

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
const GAS_PRICE = 1_100_000_000_000n;
const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const OP_ID = "0.0.10495279";
const KEY = (process.env.NEW_DEPLOYER_KEY || "").trim();
if (!KEY) throw new Error("NEW_DEPLOYER_KEY missing");
const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : "0x" + KEY);
const RPC = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
const chain = { id: 295, name: "Hedera Mainnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wlt = createWalletClient({ account, chain, transport: http(RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const erc20Abi = [{ type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }];
const toEvm = (id) => getAddress("0x" + BigInt(id.split(".")[2]).toString(16).padStart(40, "0"));
// Spenders can be CREATE-deployed contracts whose EVM address != long-zero(id).
// Resolve the REAL evm_address from the mirror (fall back to long-zero).
const _spCache = {};
async function spenderEvm(id) {
  if (_spCache[id]) return _spCache[id];
  let evm = null;
  try { const r = await fetch(`${MIRROR}/api/v1/accounts/${id}`); if (r.ok) evm = (await r.json()).evm_address; } catch {}
  const out = getAddress(evm && /^0x[0-9a-fA-F]{40}$/.test(evm) ? evm : "0x" + BigInt(id.split(".")[2]).toString(16).padStart(40, "0"));
  _spCache[id] = out; return out;
}

async function listAllowances() {
  let path = `/api/v1/accounts/${OP_ID}/allowances/tokens?limit=100`; const all = [];
  while (path) { const j = await (await fetch(MIRROR + path)).json(); for (const a of (j.allowances || [])) all.push(a); path = j.links && j.links.next ? j.links.next : null; }
  return all.filter((a) => BigInt(a.amount) > 0n);
}

(async () => {
  console.log(`══ Revoke ALL token allowances — ${EXECUTE ? "EXECUTE" : "DRY-RUN"} ══\n  operator: ${account.address}`);
  const allowances = await listAllowances();
  console.log(`  standing allowances (amount>0): ${allowances.length}`);
  for (const a of allowances) console.log(`   token ${a.token_id} → spender ${a.spender}`);
  if (!allowances.length) { console.log("  nothing to revoke."); return; }
  if (!EXECUTE) { console.log(`\n  PLAN: approve(spender, 0) on each → ${allowances.length} txs. Re-run with --execute.`); return; }

  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  console.log(`\n  starting nonce ${nonce}`);
  const hashes = [];
  for (const a of allowances) {
    try {
      const sp = await spenderEvm(a.spender);
      const hash = await wlt.writeContract({ account, address: toEvm(a.token_id), abi: erc20Abi, functionName: "approve", args: [sp, 0n], gas: 900_000n, gasPrice: GAS_PRICE, nonce });
      console.log(`  → revoke ${a.token_id}→${a.spender} (${sp})  nonce ${nonce}  ${hash}`);
      hashes.push(hash); nonce++;
    } catch (e) { console.log(`  ✗ submit failed ${a.token_id}→${a.spender}: ${String(e).split("\n")[0]}`); }
    await sleep(600);
  }
  console.log(`\n  submitted ${hashes.length} revokes; waiting for settlement…`);
  await sleep(20000);

  // verify + retry any remaining
  let remaining = await listAllowances();
  if (remaining.length) {
    console.log(`  ${remaining.length} still present; retrying once…`);
    nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
    for (const a of remaining) {
      try { const sp = await spenderEvm(a.spender); await wlt.writeContract({ account, address: toEvm(a.token_id), abi: erc20Abi, functionName: "approve", args: [sp, 0n], gas: 900_000n, gasPrice: GAS_PRICE, nonce }); nonce++; } catch {}
      await sleep(600);
    }
    await sleep(20000);
    remaining = await listAllowances();
  }
  console.log(`\n  ${remaining.length === 0 ? "✅ all token allowances revoked." : "⚠️ remaining: " + remaining.length}`);
  for (const a of remaining) console.log(`    still: ${a.token_id}→${a.spender}`);
})();
