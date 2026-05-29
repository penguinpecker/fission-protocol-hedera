#!/usr/bin/env node
// seed-init-rebuild-market.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Seed + initialize the freshly-deployed (uups-proxy + freeze-pt) Fission rewards
// market on Hedera mainnet (chain 295) with EQUAL SY/PT sides at an 8% APY anchor.
//
// GOAL: pool ends with totalSy == totalPt, each ≈ 2,000 HBAR-worth; operator keeps
// the matching YT (≈2,000 HBAR-worth) + the LP. Net operator outlay ≈ 4,000 HBAR.
//
// PIPELINE (single-shot initialize, matching the prior canonical markets that
// had totalSy==totalPt — see scripts/seed-rebuild.mjs + initialize-saucer-market.mjs):
//   A. Periphery.zapHbarToSy(market, operator, deadline){value: SEED_HBAR}
//        → operator receives S raw SY shares (zap works PRE-INIT: it only wraps
//          HBAR → WHBAR, swaps half → USDC on SaucerSwap V2, and calls
//          sy.depositLiquidity — it never touches the AMM. Verified: market is
//          already registeredMarket[]=true on the periphery, which is zap's only
//          gate.)
//   B. read operator SY-share balance S from the mirror node (works for any wallet).
//   C. SY.approve(market, int64.max)  [HTS allowance is int64 — uint256.max reverts]
//      market.split(S/2)  →  S/2 PT + S/2 YT to operator.
//   D. PT.approve(market, int64.max)
//   E. market.initialize(syIn=S - S/2, ptIn=S/2, anchor, lnFeeRateRoot, reserveFeePercent)
//        → pool: totalSy == totalPt == S/2 (equal sides). Operator keeps S/2 YT + LP.
//   F. read market.lastLnImpliedRate(), convert to APY, ASSERT within ±0.5% of 8%.
//
// ANCHOR (the bug that killed the 3 prior markets — per-year vs annualized):
//   setInitialLnImpliedRate() computes, with totalSy==totalPt and syIndex=1e18
//   (sy.exchangeRate() is `pure` → returns PMath.ONE), proportion=0.5 → lnProp=0,
//   so exchangeRate == initialAnchor, and:
//       lastLnImpliedRate = ln(anchor) * YEAR_SEC / ttx          (MarketMath._getLnImpliedRate)
//   implied APY = exp(lastLnImpliedRate / 1e18) - 1.
//   To get APY = A we need ln(anchor) * YEAR/ttx = ln(1+A), i.e.
//       anchor = exp( ln(1+A) * ttx / YEAR_SEC )                 ← annualized→per-period
//   For A=0.08, ttx≈90d  →  anchor ≈ 1.019154e18. (Matches redeploy-canonical-8pct-precise.mjs.)
//
// initialize() signature (contracts/src/core/FissionRewardsMarket.sol:432):
//   function initialize(uint256 syIn, uint256 ptIn, int256 initialAnchor,
//                       int256 lnFeeRateRoot_, uint256 reserveFeePercent_)
//       external onlyRole(ADMIN_ROLE) returns (uint256 lpOut)
//
// DRY-RUN by default — prints the full plan, estimated shares, anchor, implied APY,
// and every call (in order, with args + slippage floors). NO broadcast.
// Pass --execute (or EXECUTE=1) to broadcast. *A human runs the real execution.*
//
// Env:
//   NEW_DEPLOYER_KEY        ECDSA hex (required)
//   SEED_HBAR               total HBAR to commit          (default 4000)
//   TARGET_APY              annualized APY target          (default 0.08)
//   LN_FEE_ROOT             lnFeeRateRoot (e18, int256)    (default 0.01e18 = canonical)
//   RESERVE_FEE             reserveFeePercent (uint256)    (default 50  = canonical)
//   SHARES_PER_HBAR         estimate for dry-run only      (default 1_453_000 from records.txt)
//   HEDERA_MAINNET_RPC      RPC URL                        (default hashio)
// ─────────────────────────────────────────────────────────────────────────────

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

// ── flags ──
const EXECUTE = process.argv.includes("--execute") || process.env.EXECUTE === "1";
const DRY_RUN = !EXECUTE;

// ── config ──
const dep = JSON.parse(readFileSync(join(REPO, "deployments", "295.json"), "utf8"));
const PERIPHERY = getAddress(dep.contracts.periphery);
const SY        = getAddress(dep.contracts.saucerSwapLPYieldSource);
const MARKET    = getAddress(dep.market.address);

const SEED_HBAR_NUM   = Number(process.env.SEED_HBAR ?? "4000");
const SEED_HBAR       = parseEther(String(SEED_HBAR_NUM));
const TARGET_APY      = Number(process.env.TARGET_APY ?? "0.08");
const LN_FEE_ROOT     = BigInt(process.env.LN_FEE_ROOT ?? "10000000000000000"); // 0.01e18 (canonical)
const RESERVE_FEE     = BigInt(process.env.RESERVE_FEE ?? "50");                 // 50 (canonical)
const SHARES_PER_HBAR = BigInt(process.env.SHARES_PER_HBAR ?? "1453000");        // dry-run estimate only
const APY_TOLERANCE   = 0.5; // ± percentage points

const INT64_MAX = (1n << 63n) - 1n; // HTS allowance is int64 — NOT uint256.max
const YEAR_SEC  = 365 * 24 * 3600;
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

const marketAbi    = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const syAbi        = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve",   inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

// ── helpers ──
async function mirrorTokenBalance(tokenAddr, holderEvm) {
  const tokenNum = BigInt(tokenAddr).toString();
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holderEvm}/tokens?token.id=0.0.${tokenNum}&limit=1`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.tokens?.[0]?.balance ?? 0);
}

function fmtShares(raw) {
  // Display convention from records.txt: SY-display = raw / 1e6.
  return `${raw} raw (~${(Number(raw) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} SY-display)`;
}

function impliedApyFromLnRate(lnRateBig) {
  return (Math.exp(Number(lnRateBig) / 1e18) - 1) * 100;
}

async function send(label, request) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(request);
  // Confirm via the MIRROR NODE, not Hashio's waitForTransactionReceipt —
  // Hashio's eth_getTransactionByHash chokes on large value fields (the zap's
  // 4000-HBAR value => "Cannot convert 4e+21 to a BigInt"). Mirror is reliable.
  let result = null, err = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(`${MIRROR}/api/v1/contracts/results/${hash}`);
    if (r.ok) { const j = await r.json(); if (j.result) { result = j.result; err = j.error_message; break; } }
  }
  if (result !== "SUCCESS") {
    if (err) console.error("  error:", err);
    throw new Error(`${label} -> ${result || "no receipt within timeout"}`);
  }
  console.log(`  ✓ ${hash} (${result})`);
  return { hash, result };
}

// ── compute anchor (annualized → per-period) ──
const EXPIRY = BigInt(dep.market.expiry);
const nowSec = BigInt(Math.floor(Date.now() / 1000));
const ttx = Number(EXPIRY - nowSec);
if (ttx <= 0) throw new Error(`market already expired (expiry=${EXPIRY}, now=${nowSec})`);
const ANCHOR_FLOAT = Math.exp(Math.log(1 + TARGET_APY) * ttx / YEAR_SEC);
const ANCHOR = BigInt(Math.round(ANCHOR_FLOAT * 1e18));
// Predicted implied APY readback (totalSy==totalPt, syIndex=1e18 → exchangeRate==anchor):
//   lastLnImpliedRate = ln(anchor) * YEAR / ttx ; APY = exp(lastLn) - 1.
const PREDICTED_LASTLN = Math.log(ANCHOR_FLOAT) * YEAR_SEC / ttx;
const PREDICTED_APY = (Math.exp(PREDICTED_LASTLN) - 1) * 100;

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  seed-init-rebuild-market.mjs   mode=${EXECUTE ? "EXECUTE (BROADCAST)" : "DRY-RUN (no broadcast)"}`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`Operator : ${account.address}`);
  console.log(`Market   : ${MARKET}`);
  console.log(`Periphery: ${PERIPHERY}`);
  console.log(`SY adapter: ${SY}`);

  // Resolve on-chain identities.
  const shareToken = getAddress(await pub.readContract({ address: SY, abi: syAbi, functionName: "shareToken" }));
  const pt = getAddress(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "pt" }));
  const lp = getAddress(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "lp" }));
  console.log(`shareToken: ${shareToken}`);
  console.log(`PT        : ${pt}`);
  console.log(`LP        : ${lp}`);

  // Pre-flight invariants.
  const registered = await pub.readContract({ address: PERIPHERY, abi: peripheryAbi, functionName: "marketRegistered", args: [MARKET] });
  const lpSupply   = await pub.readContract({ address: lp, abi: erc20Abi, functionName: "totalSupply" });
  const lastLn0    = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "lastLnImpliedRate" });
  const opHbar     = await pub.getBalance({ address: account.address });
  console.log(`\nPre-flight:`);
  console.log(`  marketRegistered[market] : ${registered}   (zapHbarToSy gate)`);
  console.log(`  LP totalSupply           : ${lpSupply}   (must be 0 = not yet initialized)`);
  console.log(`  lastLnImpliedRate        : ${lastLn0}   (0 = fresh)`);
  console.log(`  operator HBAR balance    : ${(Number(opHbar) / 1e18).toFixed(2)} HBAR`);
  if (!registered) throw new Error("market not registered on periphery — zapHbarToSy would revert");
  if (lpSupply !== 0n) throw new Error("market already initialized (LP totalSupply != 0) — abort");
  if (opHbar < SEED_HBAR + parseEther("50")) {
    const msg = `operator HBAR (${(Number(opHbar)/1e18).toFixed(0)}) < SEED_HBAR + 50 gas buffer (${SEED_HBAR_NUM + 50})`;
    if (EXECUTE) throw new Error(msg); else console.warn(`  ⚠ ${msg} (dry-run continues)`);
  }

  // ── plan numbers ──
  console.log(`\n── PLAN ───────────────────────────────────────────────────────────`);
  console.log(`HBAR to spend (SEED_HBAR)   : ${SEED_HBAR_NUM} HBAR`);
  console.log(`  of which v3NpmFeeBudget   : 5 HBAR reserved by zap for NPM mint fee`);
  console.log(`  wrapped to WHBAR          : ~${SEED_HBAR_NUM - 5} HBAR, half swapped WHBAR→USDC (V2, fee=1500)`);
  console.log(`Time to expiry             : ${(ttx / 86400).toFixed(2)} days`);
  console.log(`Target APY                 : ${(TARGET_APY * 100).toFixed(2)}%`);
  console.log(`Computed anchor            : ${ANCHOR_FLOAT.toFixed(9)}  (= ${ANCHOR} e18)`);
  console.log(`  sanity anchor^(YEAR/ttx) : ${(ANCHOR_FLOAT ** (YEAR_SEC / ttx)).toFixed(6)}  (should be ~${(1 + TARGET_APY).toFixed(2)})`);
  console.log(`Predicted lastLnImpliedRate: ${BigInt(Math.round(PREDICTED_LASTLN * 1e18))}  → implied APY ${PREDICTED_APY.toFixed(4)}%`);
  console.log(`lnFeeRateRoot              : ${LN_FEE_ROOT}  (= ${(Number(LN_FEE_ROOT) / 1e18).toFixed(4)}e18, canonical)`);
  console.log(`reserveFeePercent          : ${RESERVE_FEE}  (AMM fee-redirect supersedes this; any valid 0..100 OK)`);

  // Estimate S for the dry-run; in execute mode the real S is read after the zap.
  const estS = (SEED_HBAR / parseEther("1")) * SHARES_PER_HBAR;
  const estHalf = estS / 2n;
  console.log(`\nEstimated SY shares S (dry-run only, ${SHARES_PER_HBAR}/HBAR from records.txt 2026-05-28 zap):`);
  console.log(`  S (total)        : ${fmtShares(estS)}`);
  console.log(`  S/2 → split      : ${fmtShares(estHalf)}   (mints S/2 PT + S/2 YT)`);
  console.log(`  syIn  (S - S/2)  : ${fmtShares(estS - estHalf)}   → pool SY side`);
  console.log(`  ptIn  (S/2)      : ${fmtShares(estHalf)}   → pool PT side  (equal sides: totalSy==totalPt)`);
  console.log(`  operator keeps   : ${fmtShares(estHalf)} YT  + the LP`);
  console.log(`  (NOTE: estimate only. Execute path reads the REAL minted S from the mirror node.)`);

  // ── ordered call list ──
  const dl = Math.floor(Date.now() / 1000) + 600;
  console.log(`\n── CALLS (in order) ───────────────────────────────────────────────`);
  console.log(`[A] Periphery.zapHbarToSy(`);
  console.log(`      market=${MARKET},`);
  console.log(`      receiver=${account.address},`);
  console.log(`      deadline=${dl})  {value: ${SEED_HBAR_NUM} HBAR}`);
  console.log(`      gas=15,000,000  gasPrice=${GAS_PRICE}`);
  console.log(`      slippage floors: amountOutMinimum=0 on the WHBAR→USDC V2 swap (periphery-internal);`);
  console.log(`                       minLiquidity=1 on sy.depositLiquidity. (Matches periphery zap code.)`);
  console.log(`[B] read shareToken.balanceOf(operator) via mirror node → S`);
  console.log(`[C1] SY.approve(market, int64.max=${INT64_MAX})            gas=1,000,000`);
  console.log(`[C2] market.split(S/2)                                     gas=4,000,000`);
  console.log(`[D]  PT.approve(market, int64.max=${INT64_MAX})            gas=1,000,000`);
  console.log(`[E]  market.initialize(`);
  console.log(`       syIn=S - S/2,`);
  console.log(`       ptIn=S/2,`);
  console.log(`       initialAnchor=${ANCHOR},`);
  console.log(`       lnFeeRateRoot=${LN_FEE_ROOT},`);
  console.log(`       reserveFeePercent=${RESERVE_FEE})                    gas=4,000,000`);
  console.log(`[F]  read market.lastLnImpliedRate() → assert APY within ±${APY_TOLERANCE}pp of ${(TARGET_APY*100).toFixed(2)}%`);

  if (DRY_RUN) {
    const pass = Math.abs(PREDICTED_APY - TARGET_APY * 100) <= APY_TOLERANCE;
    console.log(`\n── DRY-RUN APY GUARD (computed from planned anchor) ────────────────`);
    console.log(`  Predicted implied APY: ${PREDICTED_APY.toFixed(4)}%   target ${(TARGET_APY*100).toFixed(2)}% ± ${APY_TOLERANCE}pp`);
    console.log(`  ${pass ? "PASS ✓" : "FAIL ✗"} — anchor is mathematically consistent with the target APY.`);
    console.log(`\n*** DRY-RUN ONLY — no transactions broadcast. Re-run with --execute to broadcast. ***`);
    console.log(`══════════════════════════════════════════════════════════════════\n`);
    return;
  }

  // ─────────────────────── EXECUTE PATH (broadcasts) ───────────────────────
  console.log(`\n── EXECUTING (broadcasting transactions) ──────────────────────────`);

  // [A] zap (SKIP_ZAP=1 resumes after a zap that succeeded on-chain but whose
  // receipt-read crashed — uses the full current SY balance as S)
  let S;
  if (process.env.SKIP_ZAP) {
    S = await mirrorTokenBalance(shareToken, account.address);
    console.log(`\n[A] SKIP_ZAP — zap already done on-chain; using full SY balance`);
  } else {
    const syBefore = await mirrorTokenBalance(shareToken, account.address);
    await send("[A] Periphery.zapHbarToSy {value: SEED_HBAR}", {
      account, address: PERIPHERY, abi: peripheryAbi, functionName: "zapHbarToSy",
      args: [MARKET, account.address, BigInt(Math.floor(Date.now() / 1000) + 600)],
      value: SEED_HBAR, gas: 15_000_000n, gasPrice: GAS_PRICE,
    });
    await sleep(8000); // mirror-node lag for HTS balance
    S = (await mirrorTokenBalance(shareToken, account.address)) - syBefore;
  }
  console.log(`\n[B] SY shares S = ${fmtShares(S)}`);
  if (S < 1000n) throw new Error("too few SY shares minted — increase SEED_HBAR");
  const half = S / 2n;
  const syIn = S - half;
  console.log(`    S/2 (split) = ${half}   syIn = ${syIn}   ptIn = ${half}`);

  // [C1] approve SY (int64.max)
  await send("[C1] SY.approve(market, int64.max)", {
    account, address: shareToken, abi: erc20Abi, functionName: "approve",
    args: [MARKET, INT64_MAX], gas: 1_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(4000);

  // [C2] split
  await send(`[C2] market.split(${half})`, {
    account, address: MARKET, abi: marketAbi, functionName: "split",
    args: [half], gas: 4_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);
  const ptBal = await mirrorTokenBalance(pt, account.address);
  console.log(`    PT minted: ${ptBal}`);
  if (ptBal < half) throw new Error(`PT balance ${ptBal} < expected ${half} after split`);

  // [D] approve PT (int64.max)
  await send("[D] PT.approve(market, int64.max)", {
    account, address: pt, abi: erc20Abi, functionName: "approve",
    args: [MARKET, INT64_MAX], gas: 1_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(4000);

  // [E] initialize
  await send(`[E] market.initialize(syIn=${syIn}, ptIn=${half}, anchor=${ANCHOR}, lnFee=${LN_FEE_ROOT}, reserve=${RESERVE_FEE})`, {
    account, address: MARKET, abi: marketAbi, functionName: "initialize",
    args: [syIn, half, ANCHOR, LN_FEE_ROOT, RESERVE_FEE],
    gas: 4_000_000n, gasPrice: GAS_PRICE,
  });
  await sleep(8000);

  // [F] APY guard
  const lnRate = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "lastLnImpliedRate" });
  const apy = impliedApyFromLnRate(lnRate);
  const totalSy = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "totalSy" });
  const totalPt = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "totalPt" });
  const pass = Math.abs(apy - TARGET_APY * 100) <= APY_TOLERANCE;
  console.log(`\n── POST-INIT APY GUARD ────────────────────────────────────────────`);
  console.log(`  lastLnImpliedRate : ${lnRate}`);
  console.log(`  implied APY       : ${apy.toFixed(4)}%   target ${(TARGET_APY*100).toFixed(2)}% ± ${APY_TOLERANCE}pp`);
  console.log(`  totalSy / totalPt : ${totalSy} / ${totalPt}  (equal sides? ${totalSy === totalPt})`);
  console.log(`  ${pass ? "PASS ✓" : "FAIL ✗ — implied APY out of tolerance!"}`);
  console.log(`\n✅ Market seeded + initialized.`);
  console.log(`   SY in pool: ${syIn}   PT in pool: ${half}   operator keeps S/2 YT + LP`);
  if (!pass) process.exitCode = 1;
})();
