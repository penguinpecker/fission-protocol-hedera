#!/usr/bin/env node
// forensic-onchain.mjs — exhaustive REAL-FUNDS on-chain test battery for the live
// market, covering the flows the smoke test didn't: split, merge, addLiquidity,
// removeLiquidity, unzapSyToHbar, claim re-verify, slippage negative-tests (simulated),
// and Lens-preview accuracy. Self-contained: grants approvals at start, revokes at end.
// DRY-RUN default; --execute to broadcast. Env: NEW_DEPLOYER_KEY.

import { createPublicClient, createWalletClient, http, parseEther, getAddress } from "viem";
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
const PERIPHERY = getAddress(dep.contracts.periphery);
const SY = getAddress(dep.contracts.saucerSwapLPYieldSource);
const LENS = getAddress(dep.contracts.lens);
const MARKET = getAddress(dep.market.address);
const SMOKE_HBAR = parseEther(String(process.env.SMOKE_HBAR ?? "80"));
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

const marketAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const peripheryAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;
const syAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8")).abi;
const lensAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionLens.sol/FissionLens.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function mbal(token, holder) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}/tokens?token.id=0.0.${BigInt(token)}&limit=1`);
  if (!r.ok) return 0n; const j = await r.json(); return BigInt(j?.tokens?.[0]?.balance ?? 0);
}
async function mhbar(holder) { const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}`); if (!r.ok) return 0n; return BigInt((await r.json())?.balance?.balance ?? 0); }
async function send(label, request) {
  // Non-throwing: records a FAIL check and returns null so the battery continues
  // (so one reverting flow doesn't skip the rest + cleanup).
  console.log(`→ ${label}`);
  try {
    const hash = await wlt.writeContract(request);
    let result = null, err = null;
    for (let i = 0; i < 40; i++) { await sleep(2000); const r = await fetch(`${MIRROR}/api/v1/contracts/results/${hash}`); if (r.ok) { const j = await r.json(); if (j.result) { result = j.result; err = j.error_message; break; } } }
    if (result !== "SUCCESS") { if (err) console.error("  error:", err); console.log(`  ✗ ${label} -> ${result || "no receipt"}`); checks.push({ name: label + " (tx)", ok: false }); return null; }
    console.log(`  ✓ ${hash}`); return hash;
  } catch (e) { console.log(`  ✗ ${label}: ${String(e).split("\n")[0]}`); checks.push({ name: label + " (tx)", ok: false }); return null; }
}
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 900);
const checks = [];
const expect = (name, cond, detail) => { checks.push({ name, ok: !!cond }); console.log(`     ${cond ? "PASS ✓" : "FAIL ✗"} ${name}${detail ? "  (" + detail + ")" : ""}`); };

(async () => {
  console.log(`══ Forensic on-chain battery — ${EXECUTE ? "EXECUTE" : "DRY-RUN"} ══\n  operator ${account.address}`);
  const pt = getAddress(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "pt" }));
  const yt = getAddress(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "yt" }));
  const lp = getAddress(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "lp" }));
  const share = getAddress(await pub.readContract({ address: SY, abi: syAbi, functionName: "shareToken" }));
  const bal = async () => ({ hbar: await mhbar(account.address), sy: await mbal(share, account.address), pt: await mbal(pt, account.address), yt: await mbal(yt, account.address), lp: await mbal(lp, account.address) });
  const b0 = await bal();
  console.log(`  start: HBAR=${(Number(b0.hbar) / 1e8).toFixed(2)} SY=${b0.sy} PT=${b0.pt} YT=${b0.yt} LP=${b0.lp}`);

  // ── NEGATIVE / SLIPPAGE TESTS (simulate-only, expect revert) ──
  console.log(`\n── negative tests (simulate; expect revert) ──`);
  const revs = async (label, req) => { try { await pub.simulateContract(req); expect(label + " reverts as expected", false, "did NOT revert"); } catch { expect(label + " reverts as expected", true); } };
  await revs("buySyForPt with impossible minPtOut", { account, address: PERIPHERY, abi: peripheryAbi, functionName: "buySyForPt", args: [MARKET, 1_000_000n, INT64_MAX, account.address, deadline()] });
  await revs("removeLiquidity with impossible minSyOut", { account, address: MARKET, abi: marketAbi, functionName: "removeLiquidity", args: [1_000_000n, INT64_MAX, 0n, account.address] });
  await revs("split(0) zero-amount", { account, address: MARKET, abi: marketAbi, functionName: "split", args: [0n] });

  // ── Lens preview accuracy (read-only) ──
  console.log(`\n── Lens preview sanity ──`);
  const previewSy = await pub.readContract({ address: LENS, abi: lensAbi, functionName: "previewSwapExactSyForPt", args: [MARKET, 50_000_000n] }).catch(() => 0n);
  expect("Lens previewSwapExactSyForPt returns sane SY cost for 50M PT", previewSy > 0n && previewSy < 60_000_000n, `syUsed=${previewSy}`);

  if (!EXECUTE) { console.log(`\n  (negative + Lens checks done. Re-run with --execute for the real-funds flow battery.)`); summary(); return; }

  // ── real-funds flow battery ──
  await send(`zapHbarToSy {${process.env.SMOKE_HBAR ?? "80"} HBAR}`, { account, address: PERIPHERY, abi: peripheryAbi, functionName: "zapHbarToSy", args: [MARKET, account.address, deadline()], value: SMOKE_HBAR, gas: 15_000_000n, gasPrice: GAS_PRICE });
  await sleep(8000);
  const b1 = await bal(); const S = b1.sy - b0.sy;
  expect("zap produced SY", S > 0n, `+${S}`);

  await send(`setOperator(periphery,true)`, { account, address: MARKET, abi: marketAbi, functionName: "setOperator", args: [PERIPHERY, true], gas: 1_000_000n, gasPrice: GAS_PRICE });
  await sleep(3000);
  await send(`SY.approve(market)`, { account, address: share, abi: erc20Abi, functionName: "approve", args: [MARKET, INT64_MAX], gas: 1_000_000n, gasPrice: GAS_PRICE });
  await sleep(3000);
  await send(`SY.approve(periphery)`, { account, address: share, abi: erc20Abi, functionName: "approve", args: [PERIPHERY, INT64_MAX], gas: 1_000_000n, gasPrice: GAS_PRICE });
  await sleep(3000);

  // SPLIT
  const splitAmt = S / 3n;
  await send(`split(${splitAmt})`, { account, address: MARKET, abi: marketAbi, functionName: "split", args: [splitAmt], gas: 4_000_000n, gasPrice: GAS_PRICE });
  await sleep(8000);
  const b2 = await bal();
  expect("split minted PT", b2.pt - b1.pt >= splitAmt - 2n, `PT +${b2.pt - b1.pt}`);
  expect("split minted YT", b2.yt - b1.yt >= splitAmt - 2n, `YT +${b2.yt - b1.yt}`);

  // MERGE (round-trip; should return ~splitAmt SY)
  await send(`merge(${splitAmt})`, { account, address: MARKET, abi: marketAbi, functionName: "merge", args: [splitAmt], gas: 4_000_000n, gasPrice: GAS_PRICE });
  await sleep(8000);
  const b3 = await bal();
  expect("merge returned SY ~= split (conservation)", b3.sy >= b2.sy + splitAmt - 4n, `SY ${b2.sy}→${b3.sy}`);
  expect("merge burned PT back to baseline", b3.pt <= b1.pt + 2n, `PT=${b3.pt}`);

  // ADD LIQUIDITY (operator direct; frozen-PT wipe path). Split again to get PT.
  await send(`split(${splitAmt}) [for addLiquidity]`, { account, address: MARKET, abi: marketAbi, functionName: "split", args: [splitAmt], gas: 4_000_000n, gasPrice: GAS_PRICE });
  await sleep(8000);
  const b4 = await bal();
  const addSy = splitAmt / 2n, addPt = splitAmt / 2n;
  let lpOutSim = 0n;
  try { lpOutSim = (await pub.simulateContract({ account, address: MARKET, abi: marketAbi, functionName: "addLiquidity", args: [addSy, addPt, 0n, account.address] })).result; } catch (e) { console.log("  addLiquidity sim:", String(e).split("\n")[0]); }
  await send(`addLiquidity(sy=${addSy}, pt=${addPt})`, { account, address: MARKET, abi: marketAbi, functionName: "addLiquidity", args: [addSy, addPt, (lpOutSim * 90n) / 100n, account.address], gas: 5_000_000n, gasPrice: GAS_PRICE });
  await sleep(8000);
  const b5 = await bal();
  const lpGained = b5.lp - b4.lp;
  expect("addLiquidity minted LP", lpGained > 0n, `LP +${lpGained}`);

  // REMOVE LIQUIDITY (the LP just added)
  if (lpGained > 0n) {
    try {
      const sim = await pub.simulateContract({ account, address: MARKET, abi: marketAbi, functionName: "removeLiquidity", args: [lpGained, 0n, 0n, account.address] });
      await send(`removeLiquidity(${lpGained})`, { account, address: MARKET, abi: marketAbi, functionName: "removeLiquidity", args: [lpGained, (sim.result[0] * 90n) / 100n, (sim.result[1] * 90n) / 100n, account.address], gas: 5_000_000n, gasPrice: GAS_PRICE });
      await sleep(8000);
    } catch (e) { console.log("  removeLiquidity sim/exec note:", String(e).split("\n")[0]); checks.push({ name: "removeLiquidity", ok: false }); }
  } else { console.log("  (no LP gained — skipping removeLiquidity)"); }
  const b6 = await bal();
  expect("removeLiquidity burned the LP", b6.lp <= b4.lp + 2n, `LP=${b6.lp}`);
  expect("removeLiquidity returned SY", b6.sy > b5.sy, `SY ${b5.sy}→${b6.sy}`);

  // CLAIM AMM rewards (re-verify)
  let cpt = 0n, cyt = 0n;
  try { const s = await pub.simulateContract({ account, address: MARKET, abi: marketAbi, functionName: "claimAmmRewards", args: [account.address] }); cpt = s.result[0]; cyt = s.result[1]; } catch {}
  await send(`claimAmmRewards`, { account, address: MARKET, abi: marketAbi, functionName: "claimAmmRewards", args: [account.address], gas: 4_000_000n, gasPrice: GAS_PRICE });
  await sleep(8000);
  expect("claimAmmRewards executes (YT-side fee present)", cyt > 0n, `pt=${cpt} yt=${cyt}`);

  // merge any leftover PT (from the addLiquidity split remainder) with YT to clean up
  const b7 = await bal();
  const leftoverMerge = b7.pt < b7.yt ? b7.pt : b7.yt;
  if (leftoverMerge > b1.pt + 2n) {
    await send(`merge leftover(${leftoverMerge - b1.pt})`, { account, address: MARKET, abi: marketAbi, functionName: "merge", args: [leftoverMerge - b1.pt], gas: 4_000_000n, gasPrice: GAS_PRICE });
    await sleep(8000);
  }

  // UNZAP remaining SY → HBAR
  const b8 = await bal();
  const syToUnzap = b8.sy - b0.sy > 0n ? b8.sy - b0.sy : b8.sy;
  if (syToUnzap > 1000n) {
    let hbarSim = 0n;
    try { hbarSim = (await pub.simulateContract({ account, address: PERIPHERY, abi: peripheryAbi, functionName: "unzapSyToHbar", args: [SY, syToUnzap, 0n, deadline()] })).result; } catch (e) { console.log("  unzap sim:", String(e).split("\n")[0]); }
    await send(`unzapSyToHbar(${syToUnzap})`, { account, address: PERIPHERY, abi: peripheryAbi, functionName: "unzapSyToHbar", args: [SY, syToUnzap, (hbarSim * 80n) / 100n, deadline()], gas: 15_000_000n, gasPrice: GAS_PRICE });
    await sleep(8000);
    const b9 = await bal();
    expect("unzapSyToHbar reduced SY", b9.sy < b8.sy, `SY ${b8.sy}→${b9.sy}`);
  }

  // ── CLEANUP: revoke approvals + operator ──
  console.log(`\n── cleanup (revoke approvals + operator) ──`);
  await send(`SY.approve(market,0)`, { account, address: share, abi: erc20Abi, functionName: "approve", args: [MARKET, 0n], gas: 900_000n, gasPrice: GAS_PRICE });
  await sleep(3000);
  await send(`SY.approve(periphery,0)`, { account, address: share, abi: erc20Abi, functionName: "approve", args: [PERIPHERY, 0n], gas: 900_000n, gasPrice: GAS_PRICE });
  await sleep(3000);
  await send(`setOperator(periphery,false)`, { account, address: MARKET, abi: marketAbi, functionName: "setOperator", args: [PERIPHERY, false], gas: 1_000_000n, gasPrice: GAS_PRICE });

  summary();

  function _noop() {}
})().catch((e) => { console.error("FATAL:", e.message); summary(); process.exitCode = 1; });

function summary() {
  console.log(`\n── BATTERY SUMMARY ──`);
  for (const c of checks) console.log(`  ${c.ok ? "PASS ✓" : "FAIL ✗"}  ${c.name}`);
  const ok = checks.every((c) => c.ok);
  console.log(`\n  ${ok ? "✅ ALL ON-CHAIN CHECKS PASSED" : "❌ SOME CHECKS FAILED"}`);
}
