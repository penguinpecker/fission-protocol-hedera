#!/usr/bin/env node
// add-canonical-lp.mjs — top up canonical market LP with N HBAR.
//
// Flow (5 txs total):
//   1. Periphery.setMaxTradeBps(2000)  // raise 5% → 20% temporarily;
//                                         needed because the LP-add's swap
//                                         portion would otherwise trip the
//                                         X-3 cap. operator owns Periphery.
//   2. Periphery.zapHbarToSy(market, operator, deadline) {value: N HBAR}
//        → operator receives SY shares
//   3. shareToken.approve(Periphery, int64.max)
//   4. Periphery.buySyForLp(market, sy, ptShareBps=5000,
//                           ptOutFromSwap=sy/2, minLpOut=0, operator,
//                           deadline)
//        → operator receives LP shares (curve-mediated, AMM-routed)
//   5. Periphery.setMaxTradeBps(500)    // restore default

import {
  Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId,
  Hbar, PrivateKey,
} from "@hashgraph/sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

function loadDotenv() {
  const envPath = join(REPO, ".env");
  if (!existsSync(envPath)) throw new Error("no .env at repo root");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
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

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const HBAR_TO_ADD = BigInt(process.env.HBAR_TO_ADD ?? "1000"); // whole HBAR

const OP_ID = process.env.NEW_DEPLOYER_ID;
const OP_KEY = process.env.NEW_DEPLOYER_KEY;
if (!OP_ID || !OP_KEY) throw new Error("missing NEW_DEPLOYER_ID or NEW_DEPLOYER_KEY in .env");
const OP_EVM = "0xa7e128326861d2eedc68ed82e2a5eb5f653a11a7";

const MARKET = "0xfd33ccb2385ec20c4b7bc682712fb92e01e87d5f";
const SY_ADAPTER = "0x0000000000000000000000000000000000a0289a";
const SHARE_TOKEN = "0x0000000000000000000000000000000000a0289b";
const PERIPHERY = "0x0000000000000000000000000000000000a02731";

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const MAX_HTS_APPROVE = ((1n << 63n) - 1n).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = Client.forMainnet().setOperator(OP_ID, PrivateKey.fromStringECDSA(OP_KEY));
// Per-tx fee set via setMaxTransactionFee inside Hbar.fromTinybars elsewhere.

async function evmToEntity(evm) {
  const lower = evm.startsWith("0x") ? evm.slice(2).toLowerCase() : evm.toLowerCase();
  if (lower.startsWith("00000000000000000000000000000000")) {
    return `0.0.${BigInt("0x" + lower).toString()}`;
  }
  const r = await fetch(`${MIRROR}/api/v1/contracts/0x${lower}`);
  if (!r.ok) throw new Error(`mirror lookup failed for ${evm}: ${r.status}`);
  return (await r.json()).contract_id;
}

async function tokenBalance(token, holder) {
  const tokenNum = BigInt("0x" + token.slice(2).toLowerCase()).toString();
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}/tokens?token.id=0.0.${tokenNum}&limit=1`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.tokens?.[0]?.balance ?? 0);
}

async function nativeHbar(holder) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}`);
  if (!r.ok) return 0n;
  return BigInt((await r.json())?.balance?.balance ?? 0);
}

async function exec(label, contractIdStr, fnName, params, gas, payable = 0) {
  if (DRY_RUN) { console.log(`  [DRY] ${label}`); return null; }
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractIdStr))
    .setFunction(fnName, params)
    .setGas(gas)
    .setMaxTransactionFee(Hbar.fromTinybars(payable > 0 ? Math.max(payable + 30 * 100_000_000, 50 * 100_000_000) : 30 * 100_000_000));
  if (payable > 0) tx.setPayableAmount(Hbar.fromTinybars(payable));
  const res = await tx.execute(client);
  const rec = await res.getReceipt(client);
  console.log(`  ✓ ${label}  tx=${res.transactionId.toString()}  status=${rec.status.toString()}`);
  return res.transactionId.toString();
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`add-canonical-lp.mjs  (DRY_RUN=${DRY_RUN}, HBAR_TO_ADD=${HBAR_TO_ADD})`);
  console.log(`operator: ${OP_ID}  /  ${OP_EVM}\n`);

  const peripheryEntity = await evmToEntity(PERIPHERY);
  const shareTokenEntity = await evmToEntity(SHARE_TOKEN);
  const marketEntity = await evmToEntity(MARKET);

  const hbarStart = await nativeHbar(OP_EVM);
  const shareStart = await tokenBalance(SHARE_TOKEN, OP_EVM);
  console.log(`Before:`);
  console.log(`  HBAR:        ${Number(hbarStart) / 1e8} HBAR`);
  console.log(`  SY-share:    ${shareStart}`);
  console.log();

  // ── [1] raise cap to 20%
  console.log(`[1] Periphery.setMaxTradeBps(2000)  // temporarily raise from 500`);
  await exec(
    "raise cap",
    peripheryEntity,
    "setMaxTradeBps",
    new ContractFunctionParameters().addUint16(2000),
    300_000,
  );
  if (!DRY_RUN) await sleep(4000);

  // ── [2] zapHbarToSy {value: N HBAR}
  const tinybar = (HBAR_TO_ADD * 100_000_000n);
  console.log(`\n[2] Periphery.zapHbarToSy(market, operator, deadline)  msg.value=${HBAR_TO_ADD} HBAR`);
  const deadline = (Math.floor(Date.now() / 1000) + 600).toString();
  await exec(
    "zapHbarToSy",
    peripheryEntity,
    "zapHbarToSy",
    new ContractFunctionParameters()
      .addAddress(MARKET.slice(2))
      .addAddress(OP_EVM.slice(2))
      .addUint256(deadline),
    4_000_000,
    Number(tinybar),
  );
  if (!DRY_RUN) await sleep(8000);

  // Read SY-share delta
  const shareAfterZap = await tokenBalance(SHARE_TOKEN, OP_EVM);
  const syReceived = shareAfterZap - shareStart;
  console.log(`  SY-share delta: ${syReceived}`);
  if (syReceived <= 0n) {
    console.error("!! zapHbarToSy didn't increase operator SY-share balance — aborting");
    process.exit(1);
  }

  // ── [3] approve shareToken → Periphery
  console.log(`\n[3] shareToken.approve(Periphery, int64.max)`);
  await exec(
    "approve shareToken",
    shareTokenEntity,
    "approve",
    new ContractFunctionParameters()
      .addAddress(PERIPHERY.slice(2))
      .addUint256(MAX_HTS_APPROVE),
    1_000_000,
  );
  if (!DRY_RUN) await sleep(4000);

  // ── [4] buySyForLp — split 50/50, ptOutFromSwap=syReceived/2
  const deadline2 = (Math.floor(Date.now() / 1000) + 600).toString();
  const ptShareBps = 5000;
  const ptOutFromSwap = (syReceived / 2n).toString();
  console.log(`\n[4] Periphery.buySyForLp(market, ${syReceived}, ${ptShareBps}, ${ptOutFromSwap}, 0, operator, deadline)`);
  await exec(
    "buySyForLp",
    peripheryEntity,
    "buySyForLp",
    new ContractFunctionParameters()
      .addAddress(MARKET.slice(2))
      .addUint256(syReceived.toString())
      .addUint16(ptShareBps)
      .addUint256(ptOutFromSwap)
      .addUint256("0")
      .addAddress(OP_EVM.slice(2))
      .addUint256(deadline2),
    5_000_000,
  );
  if (!DRY_RUN) await sleep(8000);

  // ── [5] restore cap
  console.log(`\n[5] Periphery.setMaxTradeBps(500)  // restore default`);
  await exec(
    "restore cap",
    peripheryEntity,
    "setMaxTradeBps",
    new ContractFunctionParameters().addUint16(500),
    300_000,
  );
  if (!DRY_RUN) await sleep(4000);

  // ── final state
  const hbarEnd = await nativeHbar(OP_EVM);
  const shareEnd = await tokenBalance(SHARE_TOKEN, OP_EVM);
  console.log(`\nAfter:`);
  console.log(`  HBAR:        ${Number(hbarEnd) / 1e8} HBAR  (Δ ${Number(hbarEnd - hbarStart) / 1e8})`);
  console.log(`  SY-share:    ${shareEnd}  (Δ ${shareEnd - shareStart})`);

  // Pool size
  process.exit(0);
})();
