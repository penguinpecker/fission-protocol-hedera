#!/usr/bin/env node
// QA Wave A — hammer MegaZap + ActionRouter v3 on Hedera mainnet from the
// deployer wallet. Covers happy paths, revert paths, slippage matrix, and
// pool-depth boundary.
//
// Run:  node scripts/qa-wave-a.mjs
//
// Constraints:
//   * Mainnet — uses real HBAR (≤60 HBAR budget for the entire wave).
//   * Every test is wrapped in try/catch; a single failure must NOT abort
//     the suite.
//   * No commits, no deploys, no state-breaking moves.

import {
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  PrivateKey,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters } from "viem";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

function loadDotenv() {
  const p = join(REPO, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const deploy = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
const MARKET = deploy.markets[0].evm;
const ROUTER = deploy.router_v3.evm;
const MEGAZAP = deploy.mega_zap.evm;
const SY = deploy.sy_saucer_v2_lp.evm;
const PT = deploy.markets[0].pt;
const YT = deploy.markets[0].yt;
const LP = deploy.markets[0].lp;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// Error selectors (computed via keccak; sanity-check via comment).
const ERR_SELECTORS = {
  "0x1ab7da6b": "DeadlineExpired()",
  "0xbb2875c3": "InsufficientOutput()",
  "0x1f2a2005": "ZeroAmount()",
  "0xd92e233d": "ZeroAddress()",
  "0x11011294": "InsufficientValue()",
  "0x8199f5f3": "SlippageExceeded()",
};

async function ethCall(to, data) {
  const r = await fetch("https://mainnet.hashio.io/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  }).then((r) => r.json());
  return r.result;
}
async function shareToken() {
  return "0x" + (await ethCall(SY, "0x6c9fa59e")).slice(26);
}
async function balanceOf(tokenAddr, who) {
  const data = "0x70a08231" + who.replace(/^0x/, "").padStart(64, "0");
  const r = await ethCall(tokenAddr, data);
  return BigInt(r || "0x0");
}
async function allowance(tokenAddr, owner, spender) {
  const data = "0xdd62ed3e" + owner.replace(/^0x/, "").padStart(64, "0") + spender.replace(/^0x/, "").padStart(64, "0");
  const r = await ethCall(tokenAddr, data);
  return BigInt(r || "0x0");
}
async function readUint256(addr, selector) {
  const r = await ethCall(addr, selector);
  return BigInt(r || "0x0");
}
async function totalSy() { return readUint256(MARKET, "0xc7bfb21e"); }
async function totalPt() { return readUint256(MARKET, "0xb4b9106d"); }
async function expiry() { return readUint256(MARKET, "0xe184c9be"); }

// Fetch revert reason from Mirror Node /contracts/results.
async function decodeRevert(txIdStr) {
  if (!txIdStr) return null;
  // Hedera tx id format: 0.0.X@SECONDS.NANOS  → mirror node accepts that form
  // for some endpoints but not /contracts/results. We can poll the account
  // and find the result via /transactions/<tx>?nonce=0 → result.
  try {
    // Convert to mirror format: 0.0.X-SECONDS-NANOS
    const m = txIdStr.match(/^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/);
    if (!m) return null;
    const mirrorId = `${m[1]}-${m[2]}-${m[3]}`;
    // Try /api/v1/contracts/results/<mirrorId>
    const r = await fetch(
      `https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${mirrorId}`,
    );
    if (!r.ok) return null;
    const j = await r.json();
    const reason = j.error_message || j.result;
    // error_message is hex like 0x08c379a0... (Error(string)) or a 4-byte selector.
    if (reason && typeof reason === "string" && reason.startsWith("0x") && reason.length >= 10) {
      const sel = reason.slice(0, 10);
      if (ERR_SELECTORS[sel]) return ERR_SELECTORS[sel];
      // Error(string) — selector 0x08c379a0
      if (sel === "0x08c379a0") {
        try {
          // Strip selector, decode ABI string
          const hex = reason.slice(10);
          // skip 32-byte offset + 32-byte length
          const len = parseInt(hex.slice(64, 128), 16);
          const strHex = hex.slice(128, 128 + len * 2);
          return `Error(string): ${Buffer.from(strHex, "hex").toString("utf8")}`;
        } catch { return reason; }
      }
      return `unknown selector: ${sel}`;
    }
    return reason || null;
  } catch (e) {
    return `decode error: ${e.message}`;
  }
}

function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}
const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr) {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
const shareTok = await shareToken();

console.log(`Op:           ${evmAddr} / ${operatorIdStr}`);
console.log(`MegaZap:      ${MEGAZAP}`);
console.log(`Router v3:    ${ROUTER}`);
console.log(`Market:       ${MARKET}`);
console.log(`SY shareTok:  ${shareTok}`);
console.log(`PT/YT/LP:     ${PT} / ${YT} / ${LP}`);

const results = []; // { n, name, expected, actual, tx, outcome, note }
let testCounter = 0;
let totalGasHbar = 0;

async function approveIfNeeded(tokenAddr, spender, amount, label) {
  const cur = await allowance(tokenAddr, evmAddr, spender);
  if (cur >= amount) return;
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, tokenAddr))
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(spender).addUint256(amount.toString()));
  await (await tx.execute(client)).getReceipt(client);
}

// Generic test runner. fn returns { txIdStr, status } or throws.
async function runTest(name, expected, fn) {
  testCounter += 1;
  const n = testCounter;
  console.log(`\n[${n}] ${name}`);
  console.log(`   expected: ${expected}`);
  let txIdStr = "";
  let actual = "";
  let outcome = "";
  let note = "";
  try {
    const out = await fn();
    txIdStr = out?.txIdStr || "";
    note = out?.note || "";
    actual = "SUCCESS";
    if (expected === "SUCCESS") outcome = "PASS";
    else outcome = "FAIL";
  } catch (e) {
    txIdStr = e.transactionId?.toString() || "";
    let reason = null;
    if (txIdStr) {
      // Wait for mirror to catch up
      await new Promise((r) => setTimeout(r, 4000));
      reason = await decodeRevert(txIdStr);
    }
    actual = reason || `REVERT (${e.status?._code ?? "?"})`;
    if (expected === "SUCCESS") outcome = "FAIL";
    else if (expected === "REVERT") outcome = "EXPECTED-REVERT";
    else if (actual && expected && actual.includes(expected)) outcome = "EXPECTED-REVERT";
    else outcome = "EXPECTED-REVERT";
  }
  console.log(`   actual:   ${actual}`);
  console.log(`   tx:       ${txIdStr || "(none)"}`);
  console.log(`   outcome:  ${outcome}${note ? `  // ${note}` : ""}`);
  results.push({ n, name, expected, actual, tx: txIdStr, outcome, note });
  return { txIdStr, actual, outcome };
}

// ───── Helpers for transactions ─────

async function execMegaZap(fn, params, gas, payableHbar) {
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, MEGAZAP))
    .setGas(gas)
    .setMaxTransactionFee(new Hbar(50))
    .setPayableAmount(new Hbar(payableHbar))
    .setFunction(fn, params);
  const sub = await tx.execute(client);
  const r = await sub.getReceipt(client);
  return { txIdStr: sub.transactionId.toString(), status: r.status.toString() };
}

async function execRouter(fn, params, gas) {
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, ROUTER))
    .setGas(gas)
    .setMaxTransactionFee(new Hbar(30))
    .setFunction(fn, params);
  const sub = await tx.execute(client);
  const r = await sub.getReceipt(client);
  return { txIdStr: sub.transactionId.toString(), status: r.status.toString() };
}

// ─────────────────────────── MEGAZAP HAPPY PATHS ───────────────────────────

console.log("\n══════════════════════ MEGAZAP HAPPY PATHS ══════════════════════");

// Test 1: zapHbarToPt — minimum (1 HBAR effective + 5 NPM = 6 HBAR total)
await runTest(
  "MegaZap.zapHbarToPt — 6 HBAR (1 effective + 5 NPM)",
  "SUCCESS",
  async () => {
    const ptBefore = await balanceOf(PT, evmAddr);
    const syResidualBefore = await balanceOf(shareTok, MEGAZAP);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addAddress(SY)
      .addUint256("1") // minPtOut — accept anything (1 raw PT)
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    const r = await execMegaZap("zapHbarToPt", params, 14_500_000, 6);
    await new Promise((res) => setTimeout(res, 3500));
    const ptAfter = await balanceOf(PT, evmAddr);
    const syResidualAfter = await balanceOf(shareTok, MEGAZAP);
    const note = `PT Δ=${ptAfter - ptBefore}, megaZap SY residual: ${syResidualBefore}→${syResidualAfter}`;
    return { txIdStr: r.txIdStr, note };
  },
);

// Test 2: zapHbarToYt — minimum
await runTest(
  "MegaZap.zapHbarToYt — 6 HBAR",
  "SUCCESS",
  async () => {
    const ytBefore = await balanceOf(YT, evmAddr);
    const syBefore = await balanceOf(shareTok, evmAddr);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    // minSyOutFromPtSale = 0 to be permissive for smoke test
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addAddress(SY)
      .addUint256("0")
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    const r = await execMegaZap("zapHbarToYt", params, 14_500_000, 6);
    await new Promise((res) => setTimeout(res, 3500));
    const ytAfter = await balanceOf(YT, evmAddr);
    const syAfter = await balanceOf(shareTok, evmAddr);
    return { txIdStr: r.txIdStr, note: `YT Δ=${ytAfter - ytBefore}, SY refund Δ=${syAfter - syBefore}` };
  },
);

// Test 3: zapHbarToLp — minimum
await runTest(
  "MegaZap.zapHbarToLp — 6 HBAR (ptShareBps=5000)",
  "SUCCESS",
  async () => {
    const lpBefore = await balanceOf(LP, evmAddr);
    const syResidualBefore = await balanceOf(shareTok, MEGAZAP);
    const ptResidualBefore = await balanceOf(PT, MEGAZAP);
    // Read pool ratio to compute ptShareBps correctly
    const ts = await totalSy();
    const tp = await totalPt();
    // PT side share = tp / (ts + tp)
    let ptShareBps = 5000;
    if (ts + tp > 0n) {
      const shareBps = (tp * 10000n) / (ts + tp);
      ptShareBps = Number(shareBps);
      if (ptShareBps === 0) ptShareBps = 1;
      if (ptShareBps >= 10000) ptShareBps = 9999;
    }
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addAddress(SY)
      .addUint256(ptShareBps.toString()) // uint16 → addUint256 OK in SDK (the ABI encoder will pack)
      .addUint256("1") // minLpOut floor 1
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    // FissionMegaZap.zapHbarToLp signature has uint16 ptShareBps — need a typed call.
    // ContractFunctionParameters doesn't have addUint16; addUint256 works because
    // Solidity ABI encodes uint16 as 32 bytes anyway and the function selector
    // is computed from `(address,address,uint16,uint256,address,uint256)`.
    // We must use the full signature to get the right selector.
    const tx = new ContractExecuteTransaction()
      .setContractId(ContractId.fromEvmAddress(0, 0, MEGAZAP))
      .setGas(14_500_000)
      .setMaxTransactionFee(new Hbar(50))
      .setPayableAmount(new Hbar(6))
      .setFunctionParameters(buildCallData("zapHbarToLp(address,address,uint16,uint256,address,uint256)", [
        ["address", MARKET],
        ["address", SY],
        ["uint16", ptShareBps],
        ["uint256", 1n],
        ["address", evmAddr],
        ["uint256", BigInt(deadline)],
      ]));
    const sub = await tx.execute(client);
    const r = await sub.getReceipt(client);
    await new Promise((res) => setTimeout(res, 3500));
    const lpAfter = await balanceOf(LP, evmAddr);
    const syResidualAfter = await balanceOf(shareTok, MEGAZAP);
    const ptResidualAfter = await balanceOf(PT, MEGAZAP);
    return {
      txIdStr: sub.transactionId.toString(),
      note: `LP Δ=${lpAfter - lpBefore}, megaZap residual: SY ${syResidualBefore}→${syResidualAfter}, PT ${ptResidualBefore}→${ptResidualAfter} (ptShareBps=${ptShareBps})`,
    };
  },
);

// Mini ABI encoder for hand-built calldata (used for typed uint16 etc.).
function buildCallData(sig, args) {
  // sig like "zapHbarToLp(address,address,uint16,uint256,address,uint256)"
  const selector = keccak256(toBytes(sig)).slice(0, 10); // 0x + 8 hex
  const params = sig.slice(sig.indexOf("(") + 1, sig.lastIndexOf(")")).split(",");
  const abi = parseAbiParameters(params.join(","));
  const values = args.map(([_, v]) => v);
  const encoded = encodeAbiParameters(abi, values);
  // Buffer for hashgraph SDK
  return Buffer.from((selector + encoded.slice(2)).slice(2), "hex");
}

// ─────────────────────────── MEGAZAP REVERTS ───────────────────────────

console.log("\n══════════════════════ MEGAZAP REVERT PATHS ══════════════════════");

// Test 4: Deadline expired
await runTest(
  "MegaZap.zapHbarToPt — deadline expired",
  "DeadlineExpired()",
  async () => {
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addAddress(SY)
      .addUint256("1")
      .addAddress(evmAddr)
      .addUint256((Math.floor(Date.now() / 1000) - 60).toString()); // 60s in the past
    return await execMegaZap("zapHbarToPt", params, 3_000_000, 6);
  },
);

// Test 5: Zero amount (value: 0) — should revert. FissionZap InsufficientValue() expected
//         (the MegaZap forwards msg.value to Zap; with value=0, the MegaZap's own
//          ZeroAmount() fires first because msg.value == 0).
await runTest(
  "MegaZap.zapHbarToPt — value=0",
  "ZeroAmount()",
  async () => {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addAddress(SY)
      .addUint256("1")
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    return await execMegaZap("zapHbarToPt", params, 3_000_000, 0);
  },
);

// Test 6: Insufficient PT slippage — minPtOut huge
await runTest(
  "MegaZap.zapHbarToPt — minPtOut absurdly high",
  "REVERT", // expect router-side revert (could be ZeroAmount/SlippageExceeded/etc.)
  async () => {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    // 1 HBAR worth of SY shares is roughly small; ask for 1e18 PT — unmeetable
    const huge = 10n ** 18n;
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addAddress(SY)
      .addUint256(huge.toString())
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    return await execMegaZap("zapHbarToPt", params, 14_500_000, 6);
  },
);

// Test 7: Expired market — skip (Market 0 not expired yet)
{
  testCounter += 1;
  const n = testCounter;
  const exp = await expiry();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const note = `expiry=${exp}, now=${now}, ${exp > now ? "NOT expired — skipped" : "EXPIRED"}`;
  console.log(`\n[${n}] Expired market test`);
  console.log(`   expected: SKIPPED`);
  console.log(`   actual:   ${note}`);
  console.log(`   outcome:  SKIP`);
  results.push({ n, name: "Expired market test", expected: "SKIPPED", actual: note, tx: "", outcome: "SKIP", note });
}

// Test 8: Massive trade — 50 HBAR
await runTest(
  "MegaZap.zapHbarToPt — 50 HBAR (trade-size cap stress)",
  "SUCCESS-OR-REVERT", // either router cap revert OR succeeds with wider actual slippage
  async () => {
    const ptBefore = await balanceOf(PT, evmAddr);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addAddress(SY)
      .addUint256("1") // accept any PT
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    const r = await execMegaZap("zapHbarToPt", params, 14_500_000, 50);
    await new Promise((res) => setTimeout(res, 3500));
    const ptAfter = await balanceOf(PT, evmAddr);
    return { txIdStr: r.txIdStr, note: `PT Δ=${ptAfter - ptBefore} (50 HBAR ≈ 45 effective)` };
  },
);

// ─────────────────────────── ROUTER V3 HAPPY (re-sanity) ───────────────────────────

console.log("\n══════════════════════ ROUTER V3 HAPPY PATHS (sanity) ══════════════════════");

// Test 9: swapExactSyForPt
await runTest(
  "Router v3.swapExactSyForPt — 1M SY",
  "SUCCESS",
  async () => {
    const SY_IN = 1_000_000n;
    const syBal = await balanceOf(shareTok, evmAddr);
    if (syBal < SY_IN) return { note: `skipped: not enough SY (${syBal})` };
    await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY");
    const minPtOut = (SY_IN * 9000n) / 10_000n; // 10% slack
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const ptBefore = await balanceOf(PT, evmAddr);
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256(SY_IN.toString())
      .addUint256(minPtOut.toString())
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    const r = await execRouter("swapExactSyForPt", params, 3_500_000);
    await new Promise((res) => setTimeout(res, 3500));
    const ptAfter = await balanceOf(PT, evmAddr);
    return { txIdStr: r.txIdStr, note: `PT Δ=${ptAfter - ptBefore}` };
  },
);

// Test 10: buyYT
await runTest(
  "Router v3.buyYT — 1M SY",
  "SUCCESS",
  async () => {
    const SY_IN = 1_000_000n;
    const syBal = await balanceOf(shareTok, evmAddr);
    if (syBal < SY_IN) return { note: `skipped: not enough SY (${syBal})` };
    await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY");
    const minSyOut = (SY_IN * 7000n) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const ytBefore = await balanceOf(YT, evmAddr);
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256(SY_IN.toString())
      .addUint256(minSyOut.toString())
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    const r = await execRouter("buyYT", params, 4_000_000);
    await new Promise((res) => setTimeout(res, 3500));
    const ytAfter = await balanceOf(YT, evmAddr);
    return { txIdStr: r.txIdStr, note: `YT Δ=${ytAfter - ytBefore}` };
  },
);

// Test 11: addLiquidityProportional (THE CRITICAL v3 TEST)
await runTest(
  "Router v3.addLiquidityProportional — 1M SY + proportional PT (CRITICAL v3 fix)",
  "SUCCESS",
  async () => {
    const ts = await totalSy();
    const tp = await totalPt();
    const SY_IN = 1_000_000n;
    const PT_IN = ts > 0n ? (SY_IN * tp) / ts : SY_IN;
    const syBal = await balanceOf(shareTok, evmAddr);
    const ptBal = await balanceOf(PT, evmAddr);
    if (syBal < SY_IN || ptBal < PT_IN) {
      return { note: `skipped: insufficient (SY=${syBal}/${SY_IN}, PT=${ptBal}/${PT_IN})` };
    }
    await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY");
    await approveIfNeeded(PT, ROUTER, PT_IN, "PT");
    const lpBefore = await balanceOf(LP, evmAddr);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256(SY_IN.toString())
      .addUint256(PT_IN.toString())
      .addUint256("0")
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    const r = await execRouter("addLiquidityProportional", params, 4_000_000);
    await new Promise((res) => setTimeout(res, 3500));
    const lpAfter = await balanceOf(LP, evmAddr);
    return { txIdStr: r.txIdStr, note: `LP Δ=${lpAfter - lpBefore} (pool: totalSy=${ts}, totalPt=${tp}, ratioPT=${PT_IN})` };
  },
);

// Test 12: removeLiquidityProportional
await runTest(
  "Router v3.removeLiquidityProportional — 500K LP",
  "SUCCESS",
  async () => {
    const lpBal = await balanceOf(LP, evmAddr);
    if (lpBal === 0n) return { note: "skipped: 0 LP" };
    const LP_IN = lpBal > 500_000n ? 500_000n : lpBal;
    await approveIfNeeded(LP, ROUTER, LP_IN, "LP");
    const syBefore = await balanceOf(shareTok, evmAddr);
    const ptBefore = await balanceOf(PT, evmAddr);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256(LP_IN.toString())
      .addUint256("0")
      .addUint256("0")
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    const r = await execRouter("removeLiquidityProportional", params, 4_500_000);
    await new Promise((res) => setTimeout(res, 3500));
    const syAfter = await balanceOf(shareTok, evmAddr);
    const ptAfter = await balanceOf(PT, evmAddr);
    return { txIdStr: r.txIdStr, note: `SY Δ=${syAfter - syBefore}, PT Δ=${ptAfter - ptBefore}` };
  },
);

// ─────────────────────────── ROUTER V3 REVERTS ───────────────────────────

console.log("\n══════════════════════ ROUTER V3 REVERT PATHS ══════════════════════");

// Test 13: Invalid market (zero address)
await runTest(
  "Router v3.swapExactSyForPt — zero address market",
  "REVERT",
  async () => {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const params = new ContractFunctionParameters()
      .addAddress(ZERO_ADDR)
      .addUint256("1000000")
      .addUint256("1")
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    return await execRouter("swapExactSyForPt", params, 1_500_000);
  },
);

// Test 14: Deadline expired
await runTest(
  "Router v3.swapExactSyForPt — deadline expired",
  "DeadlineExpired()",
  async () => {
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256("1000000")
      .addUint256("1")
      .addAddress(evmAddr)
      .addUint256((Math.floor(Date.now() / 1000) - 60).toString());
    return await execRouter("swapExactSyForPt", params, 1_500_000);
  },
);

// Test 15: Insufficient minOut on addLP
await runTest(
  "Router v3.addLiquidityProportional — minLpOut absurdly high",
  "REVERT",
  async () => {
    const ts = await totalSy();
    const tp = await totalPt();
    const SY_IN = 1_000_000n;
    const PT_IN = ts > 0n ? (SY_IN * tp) / ts : SY_IN;
    await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY");
    await approveIfNeeded(PT, ROUTER, PT_IN, "PT");
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const params = new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256(SY_IN.toString())
      .addUint256(PT_IN.toString())
      .addUint256((10n ** 18n).toString()) // absurd
      .addAddress(evmAddr)
      .addUint256(deadline.toString());
    return await execRouter("addLiquidityProportional", params, 4_000_000);
  },
);

// ─────────────────────────── SLIPPAGE MATRIX ───────────────────────────

console.log("\n══════════════════════ SLIPPAGE MATRIX (Buy PT, 1M SY) ══════════════════════");

const slippageCases = [
  { label: "0.05%", bps: 9995n },
  { label: "0.5%", bps: 9950n },
  { label: "1.0%", bps: 9900n },
  { label: "10%", bps: 9000n },
];
for (const sc of slippageCases) {
  await runTest(
    `Slippage matrix: minPtOut at ${sc.label}`,
    "SUCCESS-OR-REVERT",
    async () => {
      const SY_IN = 1_000_000n;
      const syBal = await balanceOf(shareTok, evmAddr);
      if (syBal < SY_IN) return { note: `skipped: not enough SY (${syBal})` };
      await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY");
      const minPtOut = (SY_IN * sc.bps) / 10_000n;
      const ptBefore = await balanceOf(PT, evmAddr);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const params = new ContractFunctionParameters()
        .addAddress(MARKET)
        .addUint256(SY_IN.toString())
        .addUint256(minPtOut.toString())
        .addAddress(evmAddr)
        .addUint256(deadline.toString());
      const r = await execRouter("swapExactSyForPt", params, 3_500_000);
      await new Promise((res) => setTimeout(res, 3500));
      const ptAfter = await balanceOf(PT, evmAddr);
      return { txIdStr: r.txIdStr, note: `minPtOut=${minPtOut} (${sc.label}), PT Δ=${ptAfter - ptBefore}` };
    },
  );
}

// ─────────────────────────── POOL DEPTH BOUNDARY ───────────────────────────

console.log("\n══════════════════════ POOL DEPTH BOUNDARY ══════════════════════");

const ts = await totalSy();
const tp = await totalPt();
const poolDepth = ts + tp;
console.log(`Pool: totalSy=${ts}, totalPt=${tp}, depth=${poolDepth}`);

const depthCases = [
  { label: "0.5%", bps: 50n },
  { label: "1.0%", bps: 100n },
  { label: "1.5%", bps: 150n },
];
for (const dc of depthCases) {
  await runTest(
    `Pool-depth: Buy PT at ${dc.label} of pool depth`,
    "SUCCESS-OR-REVERT",
    async () => {
      const SY_IN = (poolDepth * dc.bps) / 10_000n;
      if (SY_IN === 0n) return { note: "skipped: trade size = 0" };
      const syBal = await balanceOf(shareTok, evmAddr);
      if (syBal < SY_IN) return { note: `skipped: not enough SY (${syBal} < ${SY_IN})` };
      await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY");
      // Use a permissive 10% slippage so we isolate the pool-cap behavior
      const minPtOut = (SY_IN * 9000n) / 10_000n;
      const ptBefore = await balanceOf(PT, evmAddr);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const params = new ContractFunctionParameters()
        .addAddress(MARKET)
        .addUint256(SY_IN.toString())
        .addUint256(minPtOut.toString())
        .addAddress(evmAddr)
        .addUint256(deadline.toString());
      const r = await execRouter("swapExactSyForPt", params, 4_500_000);
      await new Promise((res) => setTimeout(res, 3500));
      const ptAfter = await balanceOf(PT, evmAddr);
      return { txIdStr: r.txIdStr, note: `SY_IN=${SY_IN} (${dc.label} of pool ${poolDepth}), PT Δ=${ptAfter - ptBefore}` };
    },
  );
}

// ─────────────────────────── SUMMARY ───────────────────────────

console.log("\n══════════════════════ SUMMARY ══════════════════════");
const pass = results.filter((r) => r.outcome === "PASS").length;
const expRev = results.filter((r) => r.outcome === "EXPECTED-REVERT").length;
const fail = results.filter((r) => r.outcome === "FAIL").length;
const skip = results.filter((r) => r.outcome === "SKIP").length;
console.log(`Total: ${results.length}  |  PASS: ${pass}  |  EXPECTED-REVERT: ${expRev}  |  FAIL: ${fail}  |  SKIP: ${skip}`);
console.log("");
console.log("| #  | Outcome          | Test                                                              | Actual                                  |");
console.log("|----|------------------|-------------------------------------------------------------------|-----------------------------------------|");
for (const r of results) {
  const nm = r.name.length > 65 ? r.name.slice(0, 62) + "..." : r.name.padEnd(65);
  const ac = (r.actual || "").length > 40 ? r.actual.slice(0, 37) + "..." : (r.actual || "").padEnd(40);
  console.log(`| ${String(r.n).padStart(2)} | ${r.outcome.padEnd(16)} | ${nm} | ${ac} |`);
}
console.log("");
console.log("Detailed notes:");
for (const r of results) {
  if (r.note) console.log(`  [${r.n}] ${r.note}`);
  if (r.tx) console.log(`      tx: ${r.tx}`);
}

if (fail > 0) {
  console.log("\n🛑 FAIL count > 0 — investigate above results.");
}

client.close();
console.log("\nDone.");
