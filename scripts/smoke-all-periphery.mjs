#!/usr/bin/env node
// smoke-all-periphery.mjs — exercise every Periphery function with operator
// key and tiny amounts. Each pair is independent: success doesn't depend on
// the previous step. Failures get reported per-step at end.
//
// Functions tested:
//   1. zapHbarToSy(market, op, 0) {value: 5 HBAR}                → SY shares
//   2. shareToken.approve(periphery, max)
//   3. buySyForPt(market, 1 SY, 1 PT, op, 0)                     → small PT
//   4. sellPtForSy(market, 1 PT, 1 SY, op, 0)                    → SY back
//   5. buySyForYt(market, 1 SY, 0, op, 0)                        → small YT
//   6. sellYtForSy(market, 1 YT, 1, op, 0)                       → SY back
//   7. sellLpForSy(market, 1 LP, 1 SY, op, 0)                    → SY back
//   8. unzapSyToHbar(syAdapter, ~5 SY, 1, 0)                     → HBAR back
//
// Each test starts fresh, captures before/after balances, reports delta.

import {
  Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId,
  Hbar, PrivateKey,
} from "@hashgraph/sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() {
  for (const line of readFileSync(join(REPO, ".env"), "utf8").split("\n")) {
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

const OP_ID = process.env.NEW_DEPLOYER_ID;
const OP_KEY = process.env.NEW_DEPLOYER_KEY;
const OP_EVM = "0xa7e128326861d2eedc68ed82e2a5eb5f653a11a7";

const MARKET = "0x781382351c9ed32df3110b8d805d3c8c3dbfe046";
const SY_ADAPTER = "0x0000000000000000000000000000000000a0289a";
const SHARE = "0x0000000000000000000000000000000000a0289b";
const PT = "0x0000000000000000000000000000000000a034ee";
const YT = "0x0000000000000000000000000000000000a034ef";
const LP = "0x0000000000000000000000000000000000a034f0";
const PERIPHERY = "0x0000000000000000000000000000000000a02731";

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const MAX_HTS_APPROVE = ((1n << 63n) - 1n).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = Client.forMainnet().setOperator(OP_ID, PrivateKey.fromStringECDSA(OP_KEY));

async function entity(evm) {
  const lower = evm.replace(/^0x/, "").toLowerCase();
  if (lower.startsWith("00000000000000000000000000000000")) return `0.0.${BigInt("0x" + lower).toString()}`;
  const r = await fetch(`${MIRROR}/api/v1/contracts/0x${lower}`);
  if (!r.ok) throw new Error(`mirror fail ${evm}`);
  return (await r.json()).contract_id;
}
async function bal(token) {
  const num = BigInt("0x" + token.slice(2)).toString();
  const r = await fetch(`${MIRROR}/api/v1/accounts/${OP_EVM}/tokens?token.id=0.0.${num}&limit=1`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.tokens?.[0]?.balance ?? 0);
}

const results = [];
async function step(label, contractEvm, fn, params, gas, payableTinybar = 0) {
  const cid = await entity(contractEvm);
  try {
    const tx = new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(cid))
      .setFunction(fn, params)
      .setGas(gas)
      .setMaxTransactionFee(Hbar.fromTinybars((payableTinybar + 30 * 1e8).toString()));
    if (payableTinybar > 0) tx.setPayableAmount(Hbar.fromTinybars(payableTinybar.toString()));
    const res = await tx.execute(client);
    const rec = await res.getReceipt(client);
    console.log(`  ✓ ${label}  ${res.transactionId}  ${rec.status.toString()}`);
    results.push({ label, ok: true, tx: res.transactionId.toString() });
    return res;
  } catch (e) {
    const msg = e?.message ?? String(e);
    console.error(`  ✗ ${label}  ${msg.slice(0, 200)}`);
    results.push({ label, ok: false, error: msg.slice(0, 300) });
    return null;
  }
}

(async () => {
  console.log(`smoke-all-periphery.mjs (operator ${OP_ID})\n`);

  // ── 1. zapHbarToSy(market, op, 0) {value: 10 HBAR}
  // v3NpmFeeBudget is 5 HBAR — msg.value MUST exceed this strictly or
  // AmountZero reverts (the effective wrap amount becomes 0). Frontend
  // should enforce min HBAR input = v3NpmFeeBudget + 1.
  const shareBefore = await bal(SHARE);
  console.log(`SY-share before: ${shareBefore}`);
  await step(
    "1. zapHbarToSy 10 HBAR",
    PERIPHERY,
    "zapHbarToSy",
    new ContractFunctionParameters().addAddress(MARKET.slice(2)).addAddress(OP_EVM.slice(2)).addUint256("0"),
    15_000_000,
    10 * 1e8, // 10 HBAR in tinybars
  );
  await sleep(8000);
  const shareAfterZap = await bal(SHARE);
  console.log(`  SY-share delta: +${shareAfterZap - shareBefore}\n`);

  // ── 2. approve shareToken to periphery (once)
  await step(
    "2. shareToken.approve(periphery, max)",
    SHARE,
    "approve",
    new ContractFunctionParameters().addAddress(PERIPHERY.slice(2)).addUint256(MAX_HTS_APPROVE),
    1_000_000,
  );
  await sleep(4000);

  // ── 3. buySyForPt — buy ~5 PT from 5 SY (above any curve-rounding floor)
  const ptBefore = await bal(PT);
  await step(
    "3. buySyForPt 5 SY → ~5 PT",
    PERIPHERY,
    "buySyForPt",
    new ContractFunctionParameters()
      .addAddress(MARKET.slice(2)).addUint256("5000000").addUint256("3000000")
      .addAddress(OP_EVM.slice(2)).addUint256("0"),
    10_000_000,
  );
  await sleep(8000);
  console.log(`  PT delta: +${await bal(PT) - ptBefore}\n`);

  // ── 4. PT.approve(market, max) — for sellPtForSy/redeemAfterExpiry path
  await step(
    "4a. PT.approve(periphery, max)",
    PT,
    "approve",
    new ContractFunctionParameters().addAddress(PERIPHERY.slice(2)).addUint256(MAX_HTS_APPROVE),
    1_000_000,
  );
  await sleep(4000);

  // sellPtForSy — sell 3 PT back (we have at least 3 PT now)
  const shareBeforeSell = await bal(SHARE);
  await step(
    "4b. sellPtForSy 3 PT → ~2 SY",
    PERIPHERY,
    "sellPtForSy",
    new ContractFunctionParameters()
      .addAddress(MARKET.slice(2)).addUint256("3000000").addUint256("1")
      .addAddress(OP_EVM.slice(2)).addUint256("0"),
    10_000_000,
  );
  await sleep(8000);
  console.log(`  SY-share delta (from sellPt): +${await bal(SHARE) - shareBeforeSell}\n`);

  // ── 5. buySyForYt — 1 SY → some YT
  const ytBefore = await bal(YT);
  await step(
    "5. buySyForYt 1 SY → some YT",
    PERIPHERY,
    "buySyForYt",
    new ContractFunctionParameters()
      .addAddress(MARKET.slice(2)).addUint256("1000000").addUint256("0")
      .addAddress(OP_EVM.slice(2)).addUint256("0"),
    12_000_000,
  );
  await sleep(8000);
  console.log(`  YT delta: +${await bal(YT) - ytBefore}\n`);

  // ── 6. sellYtForSy needs setOperator(periphery, true) on market
  await step(
    "6a. market.setOperator(periphery, true)",
    MARKET,
    "setOperator",
    new ContractFunctionParameters().addAddress(PERIPHERY.slice(2)).addBool(true),
    1_000_000,
  );
  await sleep(4000);

  // YT.approve(periphery, max)
  await step(
    "6b. YT.approve(periphery, max)",
    YT,
    "approve",
    new ContractFunctionParameters().addAddress(PERIPHERY.slice(2)).addUint256(MAX_HTS_APPROVE),
    1_000_000,
  );
  await sleep(4000);

  const shareBeforeSellYt = await bal(SHARE);
  await step(
    "6c. sellYtForSy 500_000 YT → SY",
    PERIPHERY,
    "sellYtForSy",
    new ContractFunctionParameters()
      .addAddress(MARKET.slice(2)).addUint256("500000").addUint256("1")
      .addAddress(OP_EVM.slice(2)).addUint256("0"),
    12_000_000,
  );
  await sleep(8000);
  console.log(`  SY delta (from sellYt): +${await bal(SHARE) - shareBeforeSellYt}\n`);

  // ── 7. LP.approve + sellLpForSy 1 LP raw
  await step(
    "7a. LP.approve(periphery, max)",
    LP,
    "approve",
    new ContractFunctionParameters().addAddress(PERIPHERY.slice(2)).addUint256(MAX_HTS_APPROVE),
    1_000_000,
  );
  await sleep(4000);

  const shareBeforeSellLp = await bal(SHARE);
  await step(
    "7b. sellLpForSy 1_000_000 LP → SY",
    PERIPHERY,
    "sellLpForSy",
    new ContractFunctionParameters()
      .addAddress(MARKET.slice(2)).addUint256("1000000").addUint256("1")
      .addAddress(OP_EVM.slice(2)).addUint256("0"),
    10_000_000,
  );
  await sleep(8000);
  console.log(`  SY delta (from sellLp): +${await bal(SHARE) - shareBeforeSellLp}\n`);

  // ── 8. unzapSyToHbar — convert some SY back to HBAR (uses ~5 SY)
  // SY.shareToken approve to Periphery is already done (step 2)
  await step(
    "8. unzapSyToHbar 5 SY → HBAR",
    PERIPHERY,
    "unzapSyToHbar",
    new ContractFunctionParameters()
      .addAddress(SY_ADAPTER.slice(2)).addUint256("5000000").addUint256("1").addUint256("0"),
    10_000_000,
  );
  await sleep(8000);

  // ── final summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(" SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  console.log(`  ${ok}/${results.length} steps passed`);
  if (fail.length) {
    console.log("\n  FAILURES:");
    for (const f of fail) {
      console.log(`    - ${f.label}: ${f.error}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
