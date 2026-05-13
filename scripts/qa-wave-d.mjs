#!/usr/bin/env node
// QA Wave D — regression for every flow that worked before the MegaZap / Router v3
// upgrade. Confirms v3 didn't break the 5 pre-existing happy paths and adds
// coverage for paths test-e2e.mjs doesn't yet hit:
//
//   1.  Buy PT 1M SY  via router v3
//   2.  Buy YT 1M SY  via router v3
//   3.  Split 1M SY   via market.split
//   4.  Add LP        via router v3  (FIXED path)
//   5.  Remove LP     via router v3
//   6.  Merge PT+YT   via market.merge
//   7.  claimRewards  via market.claimRewards
//   8.  redeemAfterExpiry  expected to revert MarketNotExpired
//   9.  sy.redeemLiquidity (tiny, 1 SY share)
//  10.  Old Router v2 (abandoned)  swapExactSyForPt — expected revert
//  11.  Old Zap v1   (abandoned)  zapHbarToSy{value:5e9} — expected revert
//
// Each successful tx is then cross-checked against Mirror Node within ~5s for
// result=SUCCESS / error_message=null / sane gas (not at limit).
//
// Budget: ≤ 25 HBAR across all probes (most steps cost ~0.1 HBAR; the two
// expected-revert probes burn full gas (~5 HBAR each, capped at maxFee)).

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
const ROUTER = deploy.router_v3?.evm ?? deploy.router.evm;
const ROUTER_V2_ABANDONED = deploy.abandoned_router_v1.evm; // the abandoned router (max_auto_assoc=0)
const ZAP_V1_ABANDONED = deploy.abandoned_zap_v1.evm;
const SY = deploy.sy_saucer_v2_lp.evm;
const PT = deploy.markets[0].pt;
const YT = deploy.markets[0].yt;
const LP = deploy.markets[0].lp;
const MARKET_EXPIRY_UNIX = deploy.markets[0].expiry_unix;

// ──────────────────────────── helpers ────────────────────────────
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
async function readUint256(to, selector) {
  const r = await ethCall(to, selector);
  return BigInt(r || "0x0");
}
async function readAddr(to, selector) {
  const r = await ethCall(to, selector);
  return "0x" + (r || "0x0").slice(26).padStart(40, "0");
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

// ─────────────── Mirror-Node cross-check ───────────────
// Hedera SDK gives txId "0.0.10463169@1778710017.635895689"
// Mirror Node wants "0.0.10463169-1778710017-635895689"
// Note: only the @ and the . after it (the seconds.nanos separator) become "-".
// The account "0.0.X" dots must be preserved.
function txIdToMirror(txId) {
  const [acct, ts] = txId.split("@");
  if (!ts) return txId;
  return `${acct}-${ts.replace(".", "-")}`;
}
// Decode standard 4-byte error selectors emitted by reverts.
const REVERT_SELECTORS = {
  "0x671eb0c5": "MarketNotExpired()",
  "0xc77a194d": "YTBurnNotPermitted()",
  "0x1f2a2005": "ZeroAmount()",
  "0x11011294": "InsufficientValue()",
  "0xbb2875c3": "InsufficientOutput()",
  "0xb2094b59": "MarketExpired()",
  "0x7d404f35": "TokensNotSet()",
  "0xd92e233d": "ZeroAddress()",
  "0x559895a3": "DeadlineExceeded()",
};
function decodeRevert(errorMsg) {
  if (!errorMsg) return null;
  // mirror returns either "0x...selector..." raw bytes, or "Error(string)..."
  const cleaned = String(errorMsg).startsWith("0x") ? errorMsg : "0x" + Buffer.from(errorMsg, "utf8").toString("hex");
  if (cleaned.length < 10) return cleaned;
  const sel = cleaned.slice(0, 10).toLowerCase();
  if (REVERT_SELECTORS[sel]) return `${REVERT_SELECTORS[sel]} (sel ${sel})`;
  // Error(string)
  if (sel === "0x08c379a0") {
    try {
      const hex = cleaned.slice(10 + 64 + 64); // skip selector + offset + length
      const lenHex = cleaned.slice(10 + 64, 10 + 64 + 64);
      const len = parseInt(lenHex, 16);
      return `Error("${Buffer.from(hex.slice(0, len * 2), "hex").toString("utf8")}")`;
    } catch {
      return cleaned;
    }
  }
  return cleaned;
}
async function mirrorCheck(txId, expectRevert = false) {
  const mirrorId = txIdToMirror(txId);
  // Wait briefly for indexer
  let res = null;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${mirrorId}`);
    if (r.ok) {
      res = await r.json();
      break;
    }
  }
  if (!res) return { ok: false, reason: "mirror not found" };
  const status = res.result;
  const err = res.error_message;
  const gasUsed = res.gas_used ?? 0;
  const gasLimit = res.gas_limit ?? 0;
  const decoded = decodeRevert(err);
  const atLimit = gasLimit > 0 && gasUsed >= gasLimit - 1;
  if (expectRevert) {
    if (status === "SUCCESS") return { ok: false, reason: `expected revert but SUCCESS`, gasUsed, gasLimit };
    return { ok: true, status, decoded, gasUsed, gasLimit };
  } else {
    if (status !== "SUCCESS") return { ok: false, reason: `not SUCCESS: ${status}`, decoded, gasUsed, gasLimit };
    if (err) return { ok: false, reason: `error_message set: ${decoded}`, gasUsed, gasLimit };
    if (atLimit) return { ok: false, reason: `gas at limit ${gasUsed}/${gasLimit}`, gasUsed, gasLimit };
    return { ok: true, status, gasUsed, gasLimit };
  }
}

async function approveIfNeeded(tokenAddr, spender, amount, label) {
  const cur = await allowance(tokenAddr, evmAddr, spender);
  if (cur >= amount) {
    console.log(`   approval ${label} already >= ${amount} (cur ${cur})`);
    return;
  }
  console.log(`   approving ${label} -> ${spender}: ${amount}`);
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, tokenAddr))
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(spender).addUint256(amount.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   approval status: ${r.status.toString()}`);
}

async function execContract(contractAddr, fnSig, params, gas, label, opts = {}) {
  console.log(`\n[${label}] ${fnSig}`);
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, contractAddr))
    .setGas(gas)
    .setMaxTransactionFee(new Hbar(opts.maxFeeHbar ?? 30))
    .setFunction(fnSig.split("(")[0], params);
  if (opts.payableHbar) tx.setPayableAmount(new Hbar(opts.payableHbar));
  try {
    const submit = await tx.execute(client);
    const r = await submit.getReceipt(client);
    console.log(`   Status: ${r.status.toString()}`);
    console.log(`   Tx:     ${submit.transactionId.toString()}`);
    return { ok: r.status.toString() === "SUCCESS", tx: submit.transactionId.toString() };
  } catch (e) {
    console.log(`   REVERT  ${e.transactionId?.toString() ?? "(no id)"}  status=${e.status?._code ?? "?"}`);
    return { ok: false, tx: e.transactionId?.toString() ?? "", reverted: true };
  }
}

// Summary collector
const results = []; // { num, name, result, tx, notes }
function record(num, name, result, tx, notes) {
  results.push({ num, name, result, tx, notes });
}

console.log(`Op:           ${evmAddr} / ${operatorIdStr}`);
console.log(`Market:       ${MARKET}  (expiry unix ${MARKET_EXPIRY_UNIX})`);
const shareTok = await shareToken();
console.log(`SY shareTok:  ${shareTok}`);
console.log(`PT/YT/LP:     ${PT} / ${YT} / ${LP}`);
console.log(`Router v3:    ${ROUTER}`);
console.log(`Router v2 ab: ${ROUTER_V2_ABANDONED}`);
console.log(`Zap v1 ab:    ${ZAP_V1_ABANDONED}`);

// ─── 1: Buy PT 1M SY via router v3 ─────────────────────────────────
{
  console.log("\n=== 1: Buy PT (router.swapExactSyForPt, 1M SY) ===");
  const syBefore = await balanceOf(shareTok, evmAddr);
  const ptBefore = await balanceOf(PT, evmAddr);
  const SY_IN = 1_000_000n;
  const MIN_PT_OUT = (SY_IN * 9950n) / 10_000n; // 0.5% slippage
  await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY -> router v3");
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const r = await execContract(
    ROUTER,
    "swapExactSyForPt(address,uint256,uint256,address,uint256)",
    new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256(SY_IN.toString())
      .addUint256(MIN_PT_OUT.toString())
      .addAddress(evmAddr)
      .addUint256(deadline.toString()),
    3_500_000,
    "swapExactSyForPt",
  );
  await new Promise((r) => setTimeout(r, 3000));
  const syAfter = await balanceOf(shareTok, evmAddr);
  const ptAfter = await balanceOf(PT, evmAddr);
  const dSy = syAfter - syBefore;
  const dPt = ptAfter - ptBefore;
  console.log(`   SY  ${syBefore} -> ${syAfter}  (delta ${dSy})`);
  console.log(`   PT  ${ptBefore} -> ${ptAfter}  (delta ${dPt})`);
  let notes = `dSy ${dSy} / dPt ${dPt}`;
  if (r.ok) {
    const mc = await mirrorCheck(r.tx, false);
    notes += `; mirror ${mc.ok ? "OK" : "FAIL " + mc.reason} gas ${mc.gasUsed}/${mc.gasLimit}`;
  }
  record(1, "Buy PT v3", r.ok ? "PASS" : "FAIL", r.tx, notes);
}

// ─── 2: Buy YT 1M SY budget via router v3 ──────────────────────────
{
  console.log("\n=== 2: Buy YT (router.buyYT, 1M SY budget) ===");
  const syBefore = await balanceOf(shareTok, evmAddr);
  const ytBefore = await balanceOf(YT, evmAddr);
  const SY_IN = 1_000_000n;
  const minSyOut = (SY_IN * 7000n) / 10_000n;
  await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY -> router v3");
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const r = await execContract(
    ROUTER,
    "buyYT(address,uint256,uint256,address,uint256)",
    new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256(SY_IN.toString())
      .addUint256(minSyOut.toString())
      .addAddress(evmAddr)
      .addUint256(deadline.toString()),
    4_000_000,
    "buyYT",
  );
  await new Promise((r) => setTimeout(r, 3000));
  const syAfter = await balanceOf(shareTok, evmAddr);
  const ytAfter = await balanceOf(YT, evmAddr);
  const dSy = syAfter - syBefore;
  const dYt = ytAfter - ytBefore;
  console.log(`   SY  ${syBefore} -> ${syAfter}  (delta ${dSy})`);
  console.log(`   YT  ${ytBefore} -> ${ytAfter}  (delta ${dYt})`);
  let notes = `dSy ${dSy} / dYt ${dYt}`;
  if (r.ok) {
    const mc = await mirrorCheck(r.tx, false);
    notes += `; mirror ${mc.ok ? "OK" : "FAIL " + mc.reason} gas ${mc.gasUsed}/${mc.gasLimit}`;
  }
  record(2, "Buy YT v3", r.ok ? "PASS" : "FAIL", r.tx, notes);
}

// ─── 3: Split 1M SY directly via market ────────────────────────────
{
  console.log("\n=== 3: Split SY -> PT + YT (market.split, 1M) ===");
  const syBefore = await balanceOf(shareTok, evmAddr);
  const ptBefore = await balanceOf(PT, evmAddr);
  const ytBefore = await balanceOf(YT, evmAddr);
  const AMOUNT = 1_000_000n;
  await approveIfNeeded(shareTok, MARKET, AMOUNT, "SY -> market");
  const r = await execContract(
    MARKET,
    "split(uint256)",
    new ContractFunctionParameters().addUint256(AMOUNT.toString()),
    2_000_000,
    "split",
  );
  await new Promise((r) => setTimeout(r, 3000));
  const syAfter = await balanceOf(shareTok, evmAddr);
  const ptAfter = await balanceOf(PT, evmAddr);
  const ytAfter = await balanceOf(YT, evmAddr);
  const notes = `dSy ${syAfter - syBefore} / dPt ${ptAfter - ptBefore} / dYt ${ytAfter - ytBefore}`;
  console.log(`   ${notes}`);
  let n = notes;
  if (r.ok) {
    const mc = await mirrorCheck(r.tx, false);
    n += `; mirror ${mc.ok ? "OK" : "FAIL " + mc.reason} gas ${mc.gasUsed}/${mc.gasLimit}`;
  }
  record(3, "Split (direct)", r.ok ? "PASS" : "FAIL", r.tx, n);
}

// ─── 4: Add LP via router v3 (fixed path) ──────────────────────────
{
  console.log("\n=== 4: Add LP (router.addLiquidityProportional, 1M SY + matching PT) ===");
  // Read pool ratio with CORRECT selectors (test-e2e.mjs used wrong ones; reverts ignored & fell back to 1:1)
  const totalSy = await readUint256(MARKET, "0xc7bfb21e"); // totalSy()
  const totalPt = await readUint256(MARKET, "0xb4b9106d"); // totalPt()
  const syBefore = await balanceOf(shareTok, evmAddr);
  const ptBefore = await balanceOf(PT, evmAddr);
  const lpBefore = await balanceOf(LP, evmAddr);
  const SY_IN = 1_000_000n;
  const PT_IN = totalSy > 0n ? (SY_IN * totalPt) / totalSy : SY_IN;
  console.log(`   pool: totalSy=${totalSy}, totalPt=${totalPt} -> need PT=${PT_IN} for SY=${SY_IN}`);
  let r;
  let notes;
  if (ptBefore < PT_IN) {
    notes = `skip — insufficient PT (${ptBefore} < ${PT_IN})`;
    console.log(`   ${notes}`);
    record(4, "Add LP v3 (fixed)", "SKIP", "", notes);
  } else {
    await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY -> router v3");
    await approveIfNeeded(PT, ROUTER, PT_IN, "PT -> router v3");
    const deadline = Math.floor(Date.now() / 1000) + 600;
    r = await execContract(
      ROUTER,
      "addLiquidityProportional(address,uint256,uint256,uint256,address,uint256)",
      new ContractFunctionParameters()
        .addAddress(MARKET)
        .addUint256(SY_IN.toString())
        .addUint256(PT_IN.toString())
        .addUint256("0")
        .addAddress(evmAddr)
        .addUint256(deadline.toString()),
      4_000_000,
      "addLiquidityProportional",
    );
    await new Promise((r) => setTimeout(r, 3000));
    const syAfter = await balanceOf(shareTok, evmAddr);
    const ptAfter = await balanceOf(PT, evmAddr);
    const lpAfter = await balanceOf(LP, evmAddr);
    notes = `dSy ${syAfter - syBefore} / dPt ${ptAfter - ptBefore} / dLp ${lpAfter - lpBefore}`;
    console.log(`   ${notes}`);
    if (r.ok) {
      const mc = await mirrorCheck(r.tx, false);
      notes += `; mirror ${mc.ok ? "OK" : "FAIL " + mc.reason} gas ${mc.gasUsed}/${mc.gasLimit}`;
    }
    record(4, "Add LP v3 (fixed)", r.ok ? "PASS" : "FAIL", r.tx, notes);
  }
}

// ─── 5: Remove LP via router v3 ────────────────────────────────────
{
  console.log("\n=== 5: Remove LP (router.removeLiquidityProportional, 500K LP or less) ===");
  const lpBefore = await balanceOf(LP, evmAddr);
  if (lpBefore === 0n) {
    record(5, "Remove LP v3", "SKIP", "", "no LP to remove");
  } else {
    const syBefore = await balanceOf(shareTok, evmAddr);
    const ptBefore = await balanceOf(PT, evmAddr);
    const LP_IN = lpBefore > 500_000n ? 500_000n : lpBefore;
    await approveIfNeeded(LP, ROUTER, LP_IN, "LP -> router v3");
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const r = await execContract(
      ROUTER,
      "removeLiquidityProportional(address,uint256,uint256,uint256,address,uint256)",
      new ContractFunctionParameters()
        .addAddress(MARKET)
        .addUint256(LP_IN.toString())
        .addUint256("0")
        .addUint256("0")
        .addAddress(evmAddr)
        .addUint256(deadline.toString()),
      4_500_000,
      "removeLiquidityProportional",
    );
    await new Promise((r) => setTimeout(r, 3000));
    const syAfter = await balanceOf(shareTok, evmAddr);
    const ptAfter = await balanceOf(PT, evmAddr);
    const lpAfter = await balanceOf(LP, evmAddr);
    let notes = `dLp ${lpAfter - lpBefore} / dSy ${syAfter - syBefore} / dPt ${ptAfter - ptBefore}`;
    console.log(`   ${notes}`);
    if (r.ok) {
      const mc = await mirrorCheck(r.tx, false);
      notes += `; mirror ${mc.ok ? "OK" : "FAIL " + mc.reason} gas ${mc.gasUsed}/${mc.gasLimit}`;
    }
    record(5, "Remove LP v3", r.ok ? "PASS" : "FAIL", r.tx, notes);
  }
}

// ─── 6: Merge PT + YT -> SY via market.merge ───────────────────────
{
  console.log("\n=== 6: Merge PT+YT -> SY (market.merge, 1M) ===");
  const syBefore = await balanceOf(shareTok, evmAddr);
  const ptBefore = await balanceOf(PT, evmAddr);
  const ytBefore = await balanceOf(YT, evmAddr);
  const AMOUNT = 1_000_000n;
  let notes;
  if (ptBefore < AMOUNT || ytBefore < AMOUNT) {
    notes = `skip — insufficient PT/YT (PT ${ptBefore}, YT ${ytBefore}, need ${AMOUNT})`;
    console.log(`   ${notes}`);
    record(6, "Merge PT+YT", "SKIP", "", notes);
  } else {
    // market.merge pulls PT + YT from msg.sender — needs both approvals to market
    await approveIfNeeded(PT, MARKET, AMOUNT, "PT -> market");
    await approveIfNeeded(YT, MARKET, AMOUNT, "YT -> market");
    const r = await execContract(
      MARKET,
      "merge(uint256)",
      new ContractFunctionParameters().addUint256(AMOUNT.toString()),
      2_500_000,
      "merge",
    );
    await new Promise((r) => setTimeout(r, 3000));
    const syAfter = await balanceOf(shareTok, evmAddr);
    const ptAfter = await balanceOf(PT, evmAddr);
    const ytAfter = await balanceOf(YT, evmAddr);
    notes = `dSy ${syAfter - syBefore} / dPt ${ptAfter - ptBefore} / dYt ${ytAfter - ytBefore}`;
    console.log(`   ${notes}`);
    if (r.ok) {
      const mc = await mirrorCheck(r.tx, false);
      notes += `; mirror ${mc.ok ? "OK" : "FAIL " + mc.reason} gas ${mc.gasUsed}/${mc.gasLimit}`;
    }
    record(6, "Merge PT+YT", r.ok ? "PASS" : "FAIL", r.tx, notes);
  }
}

// ─── 7: claimRewards from rewards market ───────────────────────────
{
  console.log("\n=== 7: claimRewards(receiver) ===");
  // Rewards in this market are USDC + WHBAR (token0/token1 of the underlying SS-V2 LP).
  // Resolve token0/token1 of the SY:
  const token0 = await readAddr(SY, "0x0dfe1681");
  const token1 = await readAddr(SY, "0xd21220a7");
  const t0Before = await balanceOf(token0, evmAddr);
  const t1Before = await balanceOf(token1, evmAddr);
  console.log(`   reward tokens: ${token0} / ${token1}`);
  console.log(`   t0Before=${t0Before}  t1Before=${t1Before}`);
  const r = await execContract(
    MARKET,
    "claimRewards(address)",
    new ContractFunctionParameters().addAddress(evmAddr),
    2_500_000,
    "claimRewards",
  );
  await new Promise((r) => setTimeout(r, 3000));
  const t0After = await balanceOf(token0, evmAddr);
  const t1After = await balanceOf(token1, evmAddr);
  const dT0 = t0After - t0Before;
  const dT1 = t1After - t1Before;
  let notes = `t0 delta ${dT0} / t1 delta ${dT1} (USDC/WHBAR, may be 0 if no rewards accrued yet)`;
  console.log(`   ${notes}`);
  if (r.ok) {
    const mc = await mirrorCheck(r.tx, false);
    notes += `; mirror ${mc.ok ? "OK" : "FAIL " + mc.reason} gas ${mc.gasUsed}/${mc.gasLimit}`;
  }
  record(7, "claimRewards", r.ok ? "PASS" : "FAIL", r.tx, notes);
}

// ─── 8: redeemAfterExpiry — expected MarketNotExpired() revert ─────
{
  console.log("\n=== 8: redeemAfterExpiry (pre-expiry; expect MarketNotExpired revert) ===");
  const now = Math.floor(Date.now() / 1000);
  console.log(`   now=${now}  expiry=${MARKET_EXPIRY_UNIX}  preExpiry=${now < MARKET_EXPIRY_UNIX}`);
  const r = await execContract(
    MARKET,
    "redeemAfterExpiry(uint256,uint256,address)",
    new ContractFunctionParameters()
      .addUint256("1000000")
      .addUint256("0")
      .addAddress(evmAddr),
    2_000_000,
    "redeemAfterExpiry",
    { maxFeeHbar: 5 },
  );
  let notes = "expected revert";
  // Even on REVERT, the SDK throws but we still have the txId
  if (r.tx) {
    const mc = await mirrorCheck(r.tx, true);
    notes = `decoded: ${mc.decoded ?? "(no decode)"}; gas ${mc.gasUsed}/${mc.gasLimit}`;
  }
  // PASS if the call did NOT succeed
  record(8, "redeemAfterExpiry pre-expiry", r.ok ? "FAIL (unexpected SUCCESS)" : "PASS (reverted)", r.tx, notes);
}

// ─── 9: sy.redeemLiquidity (tiny, 1 share) ─────────────────────────
{
  console.log("\n=== 9: sy.redeemLiquidity(shares=1) ===");
  const syBefore = await balanceOf(shareTok, evmAddr);
  if (syBefore < 1n) {
    record(9, "sy.redeemLiquidity", "SKIP", "", "no SY shares");
  } else {
    const token0 = await readAddr(SY, "0x0dfe1681");
    const token1 = await readAddr(SY, "0xd21220a7");
    const t0Before = await balanceOf(token0, evmAddr);
    const t1Before = await balanceOf(token1, evmAddr);
    // redeemLiquidity burns from msg.sender directly via _burnShares — no allowance needed
    // (SYBase._burnShares wipes the user's HTS tokens via the SY treasury role; see _beforeShareUpdate)
    const r = await execContract(
      SY,
      "redeemLiquidity(uint256,uint256,uint256,address)",
      new ContractFunctionParameters()
        .addUint256("1")
        .addUint256("0")
        .addUint256("0")
        .addAddress(evmAddr),
      2_500_000,
      "redeemLiquidity",
    );
    await new Promise((r) => setTimeout(r, 3000));
    const syAfter = await balanceOf(shareTok, evmAddr);
    const t0After = await balanceOf(token0, evmAddr);
    const t1After = await balanceOf(token1, evmAddr);
    let notes = `dSy ${syAfter - syBefore} / dT0 ${t0After - t0Before} / dT1 ${t1After - t1Before}`;
    console.log(`   ${notes}`);
    if (r.ok) {
      const mc = await mirrorCheck(r.tx, false);
      notes += `; mirror ${mc.ok ? "OK" : "FAIL " + mc.reason} gas ${mc.gasUsed}/${mc.gasLimit}`;
    }
    record(9, "sy.redeemLiquidity", r.ok ? "PASS" : "FAIL", r.tx, notes);
  }
}

// ─── 10: Old Router v2 (abandoned, max_auto_assoc=0) — expect revert ─
{
  console.log(`\n=== 10: abandoned Router v2 (${ROUTER_V2_ABANDONED}) swapExactSyForPt — expect revert ===`);
  // approve to the abandoned router (cheap) then probe
  const SY_IN = 1_000_000n;
  await approveIfNeeded(shareTok, ROUTER_V2_ABANDONED, SY_IN, "SY -> abandoned router");
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const r = await execContract(
    ROUTER_V2_ABANDONED,
    "swapExactSyForPt(address,uint256,uint256,address,uint256)",
    new ContractFunctionParameters()
      .addAddress(MARKET)
      .addUint256(SY_IN.toString())
      .addUint256("0")
      .addAddress(evmAddr)
      .addUint256(deadline.toString()),
    3_500_000,
    "swapExactSyForPt(abandoned router v2)",
    { maxFeeHbar: 5 },
  );
  let notes = "expected revert (router v2 max_auto_assoc=0; HTS transferFrom into router silently fails)";
  if (r.tx) {
    const mc = await mirrorCheck(r.tx, true);
    notes = `decoded: ${mc.decoded ?? "(no decode)"}; gas ${mc.gasUsed}/${mc.gasLimit}`;
  }
  record(10, "abandoned Router v2", r.ok ? "FAIL (unexpected SUCCESS)" : "PASS (reverted)", r.tx, notes);
}

// ─── 11: Old Zap v1 (abandoned) — expect revert ────────────────────
{
  console.log(`\n=== 11: abandoned Zap v1 (${ZAP_V1_ABANDONED}) zapHbarToSy — expect revert ===`);
  // The abandoned zap v1 had wrapAmount-in-wei bug -> InsufficientValue() revert.
  // v1 signature (different from v2!): zapHbarToSy(address,uint256,uint256,uint256,uint256,uint256,uint128,address)
  // Pass wrapAmount=1e18 (1 ether in wei) to trip the wei vs. tinybar bug, with msg.value ~0.05 HBAR.
  // The contract checks `msg.value < wrapAmount` -> InsufficientValue() because 0.05 HBAR << 1e18.
  const r = await execContract(
    ZAP_V1_ABANDONED,
    "zapHbarToSy(address,uint256,uint256,uint256,uint256,uint256,uint128,address)",
    new ContractFunctionParameters()
      .addAddress(SY)
      .addUint256("1000000000000000000") // wrapAmount = 1e18 wei
      .addUint256("500000000000000000") // swapAmount = 5e17
      .addUint256("0") // usdcMinOut
      .addUint256("0") // amount0Min
      .addUint256("0") // amount1Min
      .addUint256("1") // minShares (uint128 padded)
      .addAddress(evmAddr), // receiver
    3_000_000,
    "zapHbarToSy(abandoned zap v1)",
    { maxFeeHbar: 5, payableHbar: 0.05 },
  );
  let notes = "expected revert (zap v1 wrapAmount-in-wei bug -> InsufficientValue)";
  if (r.tx) {
    const mc = await mirrorCheck(r.tx, true);
    notes = `decoded: ${mc.decoded ?? "(no decode)"}; gas ${mc.gasUsed}/${mc.gasLimit}`;
  }
  record(11, "abandoned Zap v1", r.ok ? "FAIL (unexpected SUCCESS)" : "PASS (reverted)", r.tx, notes);
}

// ─── summary table ─────────────────────────────────────────────────
console.log("\n\n══════════════════════════ SUMMARY ══════════════════════════");
console.log("| # | Flow                          | Result               | Tx                                    | Notes");
console.log("|---|-------------------------------|----------------------|---------------------------------------|------");
for (const x of results) {
  console.log(`| ${String(x.num).padEnd(1)} | ${x.name.padEnd(30)} | ${(x.result ?? "").padEnd(20)} | ${(x.tx ?? "").padEnd(37)} | ${x.notes ?? ""}`);
}

client.close();
console.log("\nDone.");
