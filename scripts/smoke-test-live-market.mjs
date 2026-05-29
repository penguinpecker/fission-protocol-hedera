#!/usr/bin/env node
// smoke-test-live-market.mjs
// ─────────────────────────────────────────────────────────────────────────────
// REAL-FUNDS smoke test of the freshly-deployed + seeded (uups-proxy + freeze-pt)
// Fission rewards market on Hedera mainnet (chain 295). Exercises every live user
// flow THROUGH THE PERIPHERY (exactly how the dapp does it), with small amounts,
// using the operator/deployer wallet.
//
// WHY THIS ORDER: the whole point of the rebuild is that PT-side AMM fees reach
// PT holders (incl. Ed25519). To prove it on the LIVE deployment we must (a) hold
// PT while fee-generating swaps happen, then (b) claim and assert the PT-side
// slice is > 0. So: buy PT (hold) → YT round-trip to generate AMM fees → claim
// (assert ptAmount>0 AND ytAmount>0) → sell PT back via the operator path.
//
// FLOW (--execute):
//   0. snapshot HBAR/SY/PT/YT/LP balances
//   1. Periphery.zapHbarToSy{value: SMOKE_HBAR}                  → SY working capital (S0)
//   2. market.setOperator(periphery, true)                       → enable frozen-PT/YT sell paths
//   3. SY.approve(periphery, int64.max)                          → periphery pulls SY for buys
//   4. Periphery.buySyForPt(syIn≈0.40·S0)                        → operator HOLDS PT (assert PT↑)
//   5a. Periphery.buySyForYt(syIn≈0.30·S0)                       → YT (assert YT↑), record delta
//   5b. Periphery.sellYtForSy(that YT delta)                     → SY (operator path; generates fees)
//   6. simulate+send market.claimAmmRewards(op)                  → (ptAmount,ytAmount); ASSERT both>0,
//                                                                  and operator SY balance ↑
//   7. Periphery.sellPtForSy(all bought PT)                      → SY (operator path; freeze-mirror wipe)
//   8. report deltas + PASS/FAIL
//
// Receipts are confirmed via the MIRROR NODE (Hashio's eth_getTransactionByHash
// chokes on large value fields, e.g. the HBAR-value zap).
//
// DRY-RUN by default (prints the plan, no broadcast). Pass --execute (or EXECUTE=1).
//
// Env: NEW_DEPLOYER_KEY (required), SMOKE_HBAR (default 100), HEDERA_MAINNET_RPC.
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicClient, createWalletClient, http, parseEther, getAddress } from "viem";
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

const EXECUTE = process.argv.includes("--execute") || process.env.EXECUTE === "1";

const dep = JSON.parse(readFileSync(join(REPO, "deployments", "295.json"), "utf8"));
const PERIPHERY = getAddress(dep.contracts.periphery);
const SY        = getAddress(dep.contracts.saucerSwapLPYieldSource);
const MARKET    = getAddress(dep.market.address);
const LENS      = getAddress(dep.contracts.lens);

const SMOKE_HBAR = parseEther(String(process.env.SMOKE_HBAR ?? "100"));
const INT64_MAX  = (1n << 63n) - 1n;
const GAS_PRICE  = 1_100_000_000_000n;
const MIRROR     = "https://mainnet-public.mirrornode.hedera.com";

const KEY = (process.env.NEW_DEPLOYER_KEY || "").trim();
if (!KEY) throw new Error("NEW_DEPLOYER_KEY missing in .env");
const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : "0x" + KEY);

const RPC = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
const chain = { id: 295, name: "Hedera Mainnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wlt = createWalletClient({ account, chain, transport: http(RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const marketAbi    = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const syAbi        = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8")).abi;
const lensAbi      = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionLens.sol/FissionLens.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve",   inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

// ── helpers ──
async function mirrorTokenBalance(tokenAddr, holderEvm) {
  const tokenNum = BigInt(tokenAddr).toString();
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holderEvm}/tokens?token.id=0.0.${tokenNum}&limit=1`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.tokens?.[0]?.balance ?? 0);
}
async function mirrorHbar(evm) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${evm}`);
  if (!r.ok) return 0n;
  return BigInt((await r.json())?.balance?.balance ?? 0); // tinybar
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
  if (result !== "SUCCESS") { if (err) console.error("  error:", err); throw new Error(`${label} -> ${result || "no receipt within timeout"}`); }
  console.log(`  ✓ ${hash} (${result})`);
  return hash;
}
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 900);
const fmt = (x) => x.toString();

(async () => {
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  Fission LIVE-market smoke test — mainnet (chain 295)`);
  console.log(`  MODE: ${EXECUTE ? "EXECUTE (broadcasting)" : "DRY-RUN (no broadcast)"}`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  operator  : ${account.address}`);
  console.log(`  market    : ${MARKET}`);
  console.log(`  periphery : ${PERIPHERY}`);
  console.log(`  SY adapter: ${SY}`);

  // resolve token addresses from the live market
  const pt = getAddress(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "pt" }));
  const yt = getAddress(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "yt" }));
  const lp = getAddress(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "lp" }));
  const shareToken = getAddress(await pub.readContract({ address: SY, abi: syAbi, functionName: "shareToken" }));
  console.log(`  PT/YT/LP  : ${pt} / ${yt} / ${lp}`);
  console.log(`  shareToken: ${shareToken}`);

  // sanity: market is initialized
  const lnRate = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "lastLnImpliedRate" });
  const lpSupply = await pub.readContract({ address: lp, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }).catch(() => 0n);
  console.log(`  lastLnImpliedRate: ${lnRate}  (≈${((Math.exp(Number(lnRate)/1e18)-1)*100).toFixed(3)}% APY)`);
  if (lnRate === 0n) throw new Error("market not initialized (lastLnImpliedRate==0)");

  const bal = async () => ({
    hbar: await mirrorHbar(account.address),
    sy:   await mirrorTokenBalance(shareToken, account.address),
    pt:   await mirrorTokenBalance(pt, account.address),
    yt:   await mirrorTokenBalance(yt, account.address),
    lp:   await mirrorTokenBalance(lp, account.address),
  });

  const b0 = await bal();
  console.log(`\n[0] balances: HBAR=${(Number(b0.hbar)/1e8).toFixed(2)}  SY=${b0.sy}  PT=${b0.pt}  YT=${b0.yt}  LP=${b0.lp}`);

  if (!EXECUTE) {
    console.log(`\n── PLAN (dry-run) ────────────────────────────────────────────────`);
    console.log(`  1. zapHbarToSy{${process.env.SMOKE_HBAR ?? "100"} HBAR} → SY (S0)`);
    console.log(`  2. setOperator(periphery,true)`);
    console.log(`  3. SY.approve(periphery, int64.max)`);
    console.log(`  4. buySyForPt(syIn≈0.40·S0)            → hold PT`);
    console.log(`  5a buySyForYt(syIn≈0.30·S0)            → YT`);
    console.log(`  5b sellYtForSy(YT delta)               → SY  (generates AMM fees)`);
    console.log(`  6. claimAmmRewards(op)  ASSERT ptAmount>0 AND ytAmount>0`);
    console.log(`  7. sellPtForSy(all bought PT)          → SY  (operator path + freeze wipe)`);
    console.log(`\n  Re-run with --execute to broadcast.`);
    return;
  }

  const checks = [];
  const expect = (name, cond, detail) => { checks.push({ name, ok: !!cond, detail }); console.log(`     ${cond ? "✓" : "✗"} ${name}${detail ? "  ("+detail+")" : ""}`); };

  // [1-3] setup: zap → SY working capital, enable operator, approve periphery.
  //   SKIP_SETUP=1 reuses an already-done setup (existing SY + setOperator + approve)
  //   so a re-run after a mid-flow failure doesn't re-spend the zap HBAR.
  let b1, S0;
  if (process.env.SKIP_SETUP) {
    console.log(`\n[1-3] SKIP_SETUP — zap/setOperator/approve already on-chain; using current SY balance`);
    b1 = b0;
    S0 = b0.sy;
    expect("existing SY working capital present", S0 > 0n, `${S0}`);
    if (S0 <= 0n) throw new Error("SKIP_SETUP set but operator holds no SY");
  } else {
    // [1] zap
    await send(`[1] zapHbarToSy {value: ${process.env.SMOKE_HBAR ?? "100"} HBAR}`, {
      account, address: PERIPHERY, abi: peripheryAbi, functionName: "zapHbarToSy",
      args: [MARKET, account.address, deadline()], value: SMOKE_HBAR, gas: 15_000_000n, gasPrice: GAS_PRICE,
    });
    await sleep(8000);
    b1 = await bal();
    S0 = b1.sy - b0.sy;
    console.log(`\n[1] SY working capital S0 = ${S0}`);
    expect("zap minted SY", S0 > 0n, `+${S0}`);
    if (S0 <= 0n) throw new Error("zap produced no SY");

    // [2] setOperator
    await send(`[2] setOperator(periphery, true)`, {
      account, address: MARKET, abi: marketAbi, functionName: "setOperator",
      args: [PERIPHERY, true], gas: 1_000_000n, gasPrice: GAS_PRICE,
    });
    await sleep(4000);

    // [3] approve SY → periphery
    await send(`[3] SY.approve(periphery, int64.max)`, {
      account, address: shareToken, abi: erc20Abi, functionName: "approve",
      args: [PERIPHERY, INT64_MAX], gas: 1_000_000n, gasPrice: GAS_PRICE,
    });
    await sleep(4000);
  }

  // [4] buy PT (hold it) — target a meaningful EXACT ptOut sized via the Lens.
  //     buySyForPt passes minPtOut straight through as the exact ptOut to
  //     market.swapExactSyForPt; a dust target (e.g. 1 wei) reverts
  //     InsufficientOutput because its SY cost rounds to 0.
  const ptTarget = (S0 * 40n) / 100n;
  const syNeeded = await pub.readContract({ address: LENS, abi: lensAbi, functionName: "previewSwapExactSyForPt", args: [MARKET, ptTarget] });
  console.log(`\n[4] target ptOut=${ptTarget}  → SY needed (Lens preview)=${syNeeded}`);
  if (syNeeded === 0n) throw new Error("Lens preview returned 0 SY for ptTarget — raise the amount");
  const buyPtBudget = (syNeeded * 110n) / 100n; // +10% buffer; periphery refunds the unused remainder
  if (buyPtBudget > b1.sy) throw new Error(`buy budget ${buyPtBudget} exceeds SY balance ${b1.sy}`);
  await send(`[4] buySyForPt(syInMax=${buyPtBudget}, ptOut=${ptTarget})`, {
    account, address: PERIPHERY, abi: peripheryAbi, functionName: "buySyForPt",
    args: [MARKET, buyPtBudget, ptTarget, account.address, deadline()], gas: 6_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);
  const b4 = await bal();
  const ptBought = b4.pt - b1.pt;
  console.log(`\n[4] PT bought = ${ptBought}`);
  expect("buySyForPt delivered PT to operator", ptBought > 0n, `+${ptBought}`);

  // [5a] buy YT
  const buyYtIn = (S0 * 30n) / 100n;
  await send(`[5a] buySyForYt(syIn=${buyYtIn})`, {
    account, address: PERIPHERY, abi: peripheryAbi, functionName: "buySyForYt",
    args: [MARKET, buyYtIn, 1n, account.address, deadline()], gas: 6_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);
  const b5a = await bal();
  const ytBought = b5a.yt - b4.yt;
  console.log(`\n[5a] YT bought = ${ytBought}`);
  expect("buySyForYt delivered YT to operator", ytBought > 0n, `+${ytBought}`);

  // [5b] sell that YT back (generates AMM fees; operator path)
  if (ytBought > 0n) {
    await send(`[5b] sellYtForSy(ytIn=${ytBought})`, {
      account, address: PERIPHERY, abi: peripheryAbi, functionName: "sellYtForSy",
      args: [MARKET, ytBought, 1n, account.address, deadline()], gas: 6_000_000n, gasPrice: GAS_PRICE,
    });
    await sleep(8000);
  }
  const b5b = await bal();
  expect("sellYtForSy returned SY (operator path on frozen YT)", b5b.sy > b5a.sy, `SY ${b5a.sy}→${b5b.sy}`);

  // [6] claim AMM rewards while HOLDING PT — the core fix on the live deployment
  let ptAmount = 0n, ytAmount = 0n;
  try {
    const sim = await pub.simulateContract({ account, address: MARKET, abi: marketAbi, functionName: "claimAmmRewards", args: [account.address] });
    ptAmount = sim.result[0]; ytAmount = sim.result[1];
  } catch (e) { console.log(`  (claim simulate note: ${String(e).split("\n")[0]})`); }
  console.log(`\n[6] claimAmmRewards preview: ptAmount=${ptAmount}  ytAmount=${ytAmount}`);
  await send(`[6] claimAmmRewards(op)`, {
    account, address: MARKET, abi: marketAbi, functionName: "claimAmmRewards",
    args: [account.address], gas: 4_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);
  const b6 = await bal();
  expect("PT-side AMM fee accrued to PT holder (THE FIX)", ptAmount > 0n, `ptAmount=${ptAmount}`);
  expect("YT-side AMM fee accrued to YT holder", ytAmount > 0n, `ytAmount=${ytAmount}`);
  expect("claim paid SY to operator", b6.sy >= b5b.sy, `SY ${b5b.sy}→${b6.sy} (+${b6.sy - b5b.sy})`);

  // [7] sell the held PT back (operator path + freeze-mirror wipe)
  if (ptBought > 0n) {
    await send(`[7] sellPtForSy(ptIn=${ptBought})`, {
      account, address: PERIPHERY, abi: peripheryAbi, functionName: "sellPtForSy",
      args: [MARKET, ptBought, 1n, account.address, deadline()], gas: 6_000_000n, gasPrice: GAS_PRICE,
    });
    await sleep(8000);
  }
  const b7 = await bal();
  expect("sellPtForSy returned SY (operator path + freeze wipe)", b7.sy > b6.sy, `SY ${b6.sy}→${b7.sy}`);
  expect("operator PT back to ~baseline after sell", b7.pt <= b1.pt + 2n, `PT=${b7.pt} (baseline ${b1.pt})`);

  // ── summary ──
  console.log(`\n── SMOKE TEST SUMMARY ─────────────────────────────────────────────`);
  for (const c of checks) console.log(`  ${c.ok ? "PASS ✓" : "FAIL ✗"}  ${c.name}`);
  const allOk = checks.every((c) => c.ok);
  console.log(`\n  net HBAR spent: ${((Number(b0.hbar) - Number(b7.hbar)) / 1e8).toFixed(2)} HBAR`);
  console.log(`  final balances: SY=${b7.sy}  PT=${b7.pt}  YT=${b7.yt}  LP=${b7.lp}`);
  console.log(`\n  ${allOk ? "✅ ALL CHECKS PASSED — live market mechanics verified with real funds." : "❌ SOME CHECKS FAILED — see above."}`);
  console.log(`\n  NOTE: operator is an ECDSA key, so its facade balanceOf works. The`);
  console.log(`  Ed25519 (HashPack-default) PT-fee path reads the _ptBal mirror and is`);
  console.log(`  proven by the unit suite; a live Ed25519 canary is the one remaining`);
  console.log(`  manual check (needs a funded Ed25519 account holding PT).`);
  if (!allOk) process.exitCode = 1;
})();
