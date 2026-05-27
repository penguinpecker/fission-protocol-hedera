#!/usr/bin/env node
// finish-canonical-lp.mjs — operator already zapped 1000 HBAR → 1,453 SY shares
// in the first run. The pool is too small for AMM-mediated buySyForLp
// (swap portion would exceed totalPt). Use direct market.split → addLiquidity.
//
// Flow:
//   1. market.split(N) → operator gets N PT + N YT (consumes N SY)
//   2. shareToken.approve(market, max)
//   3. PT.approve(market, max)
//   4. market.addLiquidity(syIn, ptIn, 0, operator) → LP
//   5. Periphery.setMaxTradeBps(500)  // restore from earlier raise
//
// Operator keeps the YT (locked-yield position; redeem at expiry or sell).

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

const OP_ID = process.env.NEW_DEPLOYER_ID;
const OP_KEY = process.env.NEW_DEPLOYER_KEY;
const OP_EVM = "0xa7e128326861d2eedc68ed82e2a5eb5f653a11a7";

const MARKET = "0xfd33ccb2385ec20c4b7bc682712fb92e01e87d5f";
const SHARE_TOKEN = "0x0000000000000000000000000000000000a0289b";
const PT_TOKEN = "0x0000000000000000000000000000000000a028aa";
const PERIPHERY = "0x0000000000000000000000000000000000a02731";

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const MAX_HTS_APPROVE = ((1n << 63n) - 1n).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = Client.forMainnet().setOperator(OP_ID, PrivateKey.fromStringECDSA(OP_KEY));

async function evmToEntity(evm) {
  const lower = evm.startsWith("0x") ? evm.slice(2).toLowerCase() : evm.toLowerCase();
  if (lower.startsWith("00000000000000000000000000000000")) return `0.0.${BigInt("0x" + lower).toString()}`;
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

async function exec(label, contractIdStr, fnName, params, gas, payable = 0) {
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractIdStr))
    .setFunction(fnName, params)
    .setGas(gas)
    .setMaxTransactionFee(Hbar.fromTinybars(20 * 100_000_000));
  if (payable > 0) tx.setPayableAmount(Hbar.fromTinybars(payable));
  const res = await tx.execute(client);
  const rec = await res.getReceipt(client);
  console.log(`  ✓ ${label}  tx=${res.transactionId.toString()}  status=${rec.status.toString()}`);
  return res.transactionId.toString();
}

(async () => {
  const marketEntity = await evmToEntity(MARKET);
  const shareEntity = await evmToEntity(SHARE_TOKEN);
  const ptEntity = await evmToEntity(PT_TOKEN);
  const peripheryEntity = await evmToEntity(PERIPHERY);

  const sySharesBefore = await tokenBalance(SHARE_TOKEN, OP_EVM);
  const ptBefore = await tokenBalance(PT_TOKEN, OP_EVM);
  console.log(`Before: SY=${sySharesBefore}  PT=${ptBefore}`);

  // Split half the SY into matching PT+YT.
  // Use NEW SY only (1453 of total 2761). Keep the original 1308 loose.
  // Split half: 1453/2 = 726. So split 726 SY → 726 PT + 726 YT.
  // Then addLiquidity(727 SY, 726 PT, 0, op) → ~726 LP.
  const newSy = 1453000000n; // 1453 SY shares in 6-dec raw — actual delta from zap
  // Actually use exact delta. Re-read the original snapshot.
  // For now, hard-code splitAmount = 726 SY (raw) - tweak if needed.
  const splitAmount = (1453_000_000n / 2n).toString(); // 726.5M raw → 726.5 SY shares to split
  const syForLp = (1453_000_000n - 1453_000_000n / 2n).toString(); // 726.5M
  const ptForLp = splitAmount; // mints 1:1

  // [1] market.split(splitAmount) — operator gets PT + YT
  console.log(`\n[1] market.split(${splitAmount})`);
  await exec(
    "split",
    marketEntity,
    "split",
    new ContractFunctionParameters().addUint256(splitAmount),
    2_500_000,
  );
  await sleep(8000);

  const sharesAfterSplit = await tokenBalance(SHARE_TOKEN, OP_EVM);
  const ptAfterSplit = await tokenBalance(PT_TOKEN, OP_EVM);
  console.log(`  After split: SY=${sharesAfterSplit}  PT=${ptAfterSplit}`);

  // [2] approve shareToken → market
  console.log(`\n[2] shareToken.approve(market, max)`);
  await exec(
    "approve SY",
    shareEntity,
    "approve",
    new ContractFunctionParameters().addAddress(MARKET.slice(2)).addUint256(MAX_HTS_APPROVE),
    1_000_000,
  );
  await sleep(4000);

  // [3] approve PT → market
  console.log(`\n[3] PT.approve(market, max)`);
  await exec(
    "approve PT",
    ptEntity,
    "approve",
    new ContractFunctionParameters().addAddress(MARKET.slice(2)).addUint256(MAX_HTS_APPROVE),
    1_000_000,
  );
  await sleep(4000);

  // [4] market.addLiquidity(syForLp, ptForLp, 0, operator)
  // addLiquidity(uint256 syIn, uint256 ptIn, uint256 minLpOut, address receiver)
  console.log(`\n[4] market.addLiquidity(${syForLp}, ${ptForLp}, 0, operator)`);
  await exec(
    "addLiquidity",
    marketEntity,
    "addLiquidity",
    new ContractFunctionParameters()
      .addUint256(syForLp)
      .addUint256(ptForLp)
      .addUint256("0")
      .addAddress(OP_EVM.slice(2)),
    3_000_000,
  );
  await sleep(8000);

  // [5] restore cap to 500 (was raised to 2000 in earlier run)
  console.log(`\n[5] Periphery.setMaxTradeBps(500)  // restore default`);
  await exec(
    "restore cap",
    peripheryEntity,
    "setMaxTradeBps",
    new ContractFunctionParameters().addUint16(500),
    300_000,
  );
  await sleep(4000);

  // Final state
  const sharesEnd = await tokenBalance(SHARE_TOKEN, OP_EVM);
  const ptEnd = await tokenBalance(PT_TOKEN, OP_EVM);
  const ytEnd = await tokenBalance("0x0000000000000000000000000000000000a028ab", OP_EVM);
  const lpEnd = await tokenBalance("0x0000000000000000000000000000000000a028ac", OP_EVM);
  console.log(`\nAfter:`);
  console.log(`  SY-shares: ${sharesEnd}  PT: ${ptEnd}  YT: ${ytEnd}  LP: ${lpEnd}`);
  process.exit(0);
})();
