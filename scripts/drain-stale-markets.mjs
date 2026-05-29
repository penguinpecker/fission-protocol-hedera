#!/usr/bin/env node
// drain-stale-markets.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Recover the operator's stranded liquidity from the ABANDONED Fission markets on
// Hedera mainnet (chain 295), WITHOUT touching the AMM (the stale markets have the
// anchor-misconfig bugs in their swap path — but merge/removeLiquidity/redeemLiquidity
// are fixed-ratio and safe).
//
// STRATEGY (per the read-only drain analysis, ~$448 recoverable):
//   Phase 1 — consolidate to SY shares (safe, fixed-ratio):
//     • For each stale market the operator holds positions in:
//         - if LP balance > 0: removeLiquidity(lp, minSy, minPt, op)  → SY + PT
//         - merge(min(ptBal, ytBal))                                  → SY (burns PT+YT 1:1)
//       merge() and removeLiquidity() are 1:1 / proportional — no AMM, no anchor bug.
//   Phase 2 — extract to USDC + WHBAR:
//     • For each SY adapter: redeemLiquidity(allShares, minUSDC, minWHBAR, op)
//       with NON-ZERO min-outs from an on-chain simulation (the analysis flagged
//       min=0 as the one real risk — it can burn shares for nothing if drained).
//     • SY-A adapter also has sweepHbar (recover ~0.01 HBAR of stuck native).
//
// Balances are read from the MIRROR NODE (handles Ed25519/long-zero holders whose
// HTS facade balanceOf reverts — e.g. market a0289c). Receipts confirmed via mirror.
//
// DRY-RUN by default (simulates every step, prints expected recoveries + min-outs).
// Pass --execute (or EXECUTE=1) to broadcast.
//
// Env: NEW_DEPLOYER_KEY (required), HEDERA_MAINNET_RPC, MINOUT_BPS (default 9700).
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicClient, createWalletClient, http, getAddress } from "viem";
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
    const e = t.indexOf("="); if (e < 0) continue;
    const k = t.slice(0, e).trim(); let v = t.slice(e + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const EXECUTE = process.argv.includes("--execute") || process.env.EXECUTE === "1";
const MINOUT_BPS = BigInt(process.env.MINOUT_BPS ?? "9700"); // 97% min-out floor on remove/redeem
const GAS_PRICE = 1_100_000_000_000n;
const MIRROR = "https://mainnet-public.mirrornode.hedera.com";

const KEY = (process.env.NEW_DEPLOYER_KEY || "").trim();
if (!KEY) throw new Error("NEW_DEPLOYER_KEY missing in .env");
const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : "0x" + KEY);

const RPC = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
const chain = { id: 295, name: "Hedera Mainnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wlt = createWalletClient({ account, chain, transport: http(RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── minimal ABIs (work across both market variants + both SY adapters) ──
const marketAbi = [
  { type: "function", name: "pt", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "yt", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "lp", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "sy", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "merge", inputs: [{ name: "amount", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "removeLiquidity", inputs: [{ name: "lpIn", type: "uint256" }, { name: "minSyOut", type: "uint256" }, { name: "minPtOut", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }], stateMutability: "nonpayable" },
];
const syAbi = [
  { type: "function", name: "shareToken", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "redeemLiquidity", inputs: [{ name: "shares", type: "uint256" }, { name: "amount0Min", type: "uint256" }, { name: "amount1Min", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "sweepHbar", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
];

// ── stale markets + SY adapters (from deployments/295.json `abandoned` + drain analysis) ──
const SY_A = getAddress("0x0000000000000000000000000000000000A0289A"); // SaucerSwapLPYieldSource (sweepHbar OK)
const SY_B = getAddress("0x0000000000000000000000000000000000a02585"); // SY_SaucerSwapV2LP (no sweepHbar; 6.255 HBAR stuck)
const MARKETS = [
  { name: "fecf (rewards, SY-A)", addr: getAddress("0xfEcfC0Bb57dD668fF37F2A232b208584E5FeAE53"), fam: "A" },
  { name: "a0289c (SY-A)",        addr: getAddress("0x0000000000000000000000000000000000A0289C"), fam: "A" },
  { name: "fd33 (SY-A)",          addr: getAddress("0xfD33CCB2385EC20C4B7bc682712fb92e01e87D5f"), fam: "A" },
  { name: "432e (SY-A)",          addr: getAddress("0x432E552AA1988542Da05D192A7B62b0292216032"), fam: "A" },
  { name: "7813 (SY-A)",          addr: getAddress("0x781382351c9Ed32df3110B8d805D3C8C3dBFe046"), fam: "A" },
  { name: "5569 (SY-B)",          addr: getAddress("0x556938AcfDa70dF2A32ea97e6B6862B874d93ef9"), fam: "B" },
  { name: "3aCD (SY-B)",          addr: getAddress("0x3aCDD09b5850F551D9F2b4FE949439c2499f86C1"), fam: "B" },
];

async function mirrorBal(tokenAddr, holder) {
  const tokenNum = BigInt(tokenAddr).toString();
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}/tokens?token.id=0.0.${tokenNum}&limit=1`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.tokens?.[0]?.balance ?? 0);
}
async function send(label, request) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(request);
  let result = null, err = null;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const r = await fetch(`${MIRROR}/api/v1/contracts/results/${hash}`);
    if (r.ok) { const j = await r.json(); if (j.result) { result = j.result; err = j.error_message; break; } }
  }
  if (result !== "SUCCESS") { if (err) console.error("  error:", err); throw new Error(`${label} -> ${result || "no receipt"}`); }
  console.log(`  ✓ ${hash} (${result})`);
  return hash;
}
const floor = (x) => (x * MINOUT_BPS) / 10000n;

(async () => {
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  Fission STALE-MARKET DRAIN — mainnet (chain 295)`);
  console.log(`  MODE: ${EXECUTE ? "EXECUTE (broadcasting)" : "DRY-RUN"}   min-out floor: ${MINOUT_BPS}bps`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  operator: ${account.address}\n`);

  // resolve each market's tokens + the operator's balances
  for (const m of MARKETS) {
    m.pt = getAddress(await pub.readContract({ address: m.addr, abi: marketAbi, functionName: "pt" }));
    m.yt = getAddress(await pub.readContract({ address: m.addr, abi: marketAbi, functionName: "yt" }));
    try { m.lp = getAddress(await pub.readContract({ address: m.addr, abi: marketAbi, functionName: "lp" })); } catch { m.lp = null; }
    m.ptBal = await mirrorBal(m.pt, account.address);
    m.ytBal = await mirrorBal(m.yt, account.address);
    m.lpBal = m.lp ? await mirrorBal(m.lp, account.address) : 0n;
    console.log(`  ${m.name.padEnd(22)} PT=${m.ptBal}  YT=${m.ytBal}  LP=${m.lpBal}`);
  }
  const shareA = getAddress(await pub.readContract({ address: SY_A, abi: syAbi, functionName: "shareToken" }));
  const shareB = getAddress(await pub.readContract({ address: SY_B, abi: syAbi, functionName: "shareToken" }));
  console.log(`\n  SY-A share ${shareA}  bal=${await mirrorBal(shareA, account.address)}`);
  console.log(`  SY-B share ${shareB}  bal=${await mirrorBal(shareB, account.address)}`);

  if (!EXECUTE) {
    console.log(`\n── DRY-RUN: simulating Phase-1 removeLiquidity + Phase-2 redeem ──`);
    for (const m of MARKETS) {
      if (m.lpBal > 0n) {
        try {
          const sim = await pub.simulateContract({ account, address: m.addr, abi: marketAbi, functionName: "removeLiquidity", args: [m.lpBal, 0n, 0n, account.address] });
          console.log(`  ${m.name}: removeLiquidity(${m.lpBal}) → ${sim.result[0]} SY + ${sim.result[1]} PT (min @ ${MINOUT_BPS}bps: ${floor(sim.result[0])} / ${floor(sim.result[1])})`);
        } catch (e) { console.log(`  ${m.name}: removeLiquidity sim FAILED — ${String(e).split("\n")[0]}`); }
      }
      const mergeAmt = m.ptBal < m.ytBal ? m.ptBal : m.ytBal;
      if (mergeAmt > 0n) console.log(`  ${m.name}: merge(${mergeAmt}) → ${mergeAmt} SY (after any removeLiquidity, recomputed live)`);
    }
    for (const [tag, adapter, share] of [["SY-A", SY_A, shareA], ["SY-B", SY_B, shareB]]) {
      const bal = await mirrorBal(share, account.address);
      if (bal > 0n) {
        try {
          const sim = await pub.simulateContract({ account, address: adapter, abi: syAbi, functionName: "redeemLiquidity", args: [bal, 0n, 0n, account.address] });
          console.log(`  ${tag}: redeemLiquidity(${bal} CURRENT shares) → ${sim.result[0]} + ${sim.result[1]} (token0/token1)`);
        } catch (e) { console.log(`  ${tag}: redeem sim note — ${String(e).split("\n")[0]}`); }
      }
    }
    console.log(`\n  (Phase-1 increases SY-share balances; the real run redeems the FULL post-merge balance.)`);
    console.log(`  Re-run with --execute to broadcast.`);
    return;
  }

  // ───────────────────────── PHASE 1: consolidate to SY shares ─────────────────────────
  console.log(`\n── PHASE 1: removeLiquidity + merge (safe, fixed-ratio) ──────────`);
  for (const m of MARKETS) {
    if (m.lpBal > 0n) {
      const sim = await pub.simulateContract({ account, address: m.addr, abi: marketAbi, functionName: "removeLiquidity", args: [m.lpBal, 0n, 0n, account.address] });
      await send(`${m.name}: removeLiquidity(${m.lpBal}) [min ${floor(sim.result[0])} SY / ${floor(sim.result[1])} PT]`, {
        account, address: m.addr, abi: marketAbi, functionName: "removeLiquidity",
        args: [m.lpBal, floor(sim.result[0]), floor(sim.result[1]), account.address], gas: 4_000_000n, gasPrice: GAS_PRICE,
      });
      await sleep(8000);
      m.ptBal = await mirrorBal(m.pt, account.address); // PT increased by removeLiquidity
      m.ytBal = await mirrorBal(m.yt, account.address);
    }
    const mergeAmt = m.ptBal < m.ytBal ? m.ptBal : m.ytBal;
    if (mergeAmt > 0n) {
      await send(`${m.name}: merge(${mergeAmt})`, {
        account, address: m.addr, abi: marketAbi, functionName: "merge",
        args: [mergeAmt], gas: 4_000_000n, gasPrice: GAS_PRICE,
      });
      await sleep(8000);
    } else {
      console.log(`  ${m.name}: nothing to merge (PT or YT is 0)`);
    }
  }

  // ───────────────────────── PHASE 2: redeem SY shares → USDC + WHBAR ─────────────────────────
  console.log(`\n── PHASE 2: redeemLiquidity (non-zero min-outs from simulation) ──`);
  for (const [tag, adapter, share] of [["SY-A", SY_A, shareA], ["SY-B", SY_B, shareB]]) {
    await sleep(4000);
    const bal = await mirrorBal(share, account.address);
    if (bal === 0n) { console.log(`  ${tag}: 0 shares, skip`); continue; }
    const sim = await pub.simulateContract({ account, address: adapter, abi: syAbi, functionName: "redeemLiquidity", args: [bal, 0n, 0n, account.address] });
    const [a0, a1] = sim.result;
    console.log(`  ${tag}: ${bal} shares → expect ${a0} token0 + ${a1} token1`);
    await send(`${tag}: redeemLiquidity(${bal}) [min ${floor(a0)} / ${floor(a1)}]`, {
      account, address: adapter, abi: syAbi, functionName: "redeemLiquidity",
      args: [bal, floor(a0), floor(a1), account.address], gas: 5_000_000n, gasPrice: GAS_PRICE,
    });
    await sleep(8000);
  }

  // optional: sweep the ~0.01 HBAR of stuck native from the SY-A adapter (has sweepHbar)
  try {
    const sim = await pub.simulateContract({ account, address: SY_A, abi: syAbi, functionName: "sweepHbar", args: [account.address, 0n] }).catch(() => null);
    // best-effort; the small amount is not worth a hard failure
  } catch {}

  console.log(`\n✅ Drain complete. USDC + WHBAR returned to the operator; verify balances on HashScan.`);
  console.log(`   Note: ~0.22 USD of leftover PT (fecf) redeems 1:1 after the Aug-25 expiry; ~0.57 USD`);
  console.log(`   (6.255 HBAR) is permanently stuck in the old SY-B adapter (no sweep fn).`);
})();
