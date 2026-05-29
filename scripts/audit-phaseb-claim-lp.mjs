#!/usr/bin/env node
// audit-phaseb-claim-lp.mjs — Phase B supplement: live-exercise the headline
// claimAmmRewards feature (with payout verification) + buySyForLp (add LP),
// the two flows smoke-all-periphery.mjs doesn't cover. Read-decode return
// values straight from the consensus record. Tiny amounts, operator key.
import {
  Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId,
  Hbar, PrivateKey,
} from "@hashgraph/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
for (const line of readFileSync(join(REPO, ".env"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const OP_ID = process.env.NEW_DEPLOYER_ID, OP_KEY = process.env.NEW_DEPLOYER_KEY;
const OP_EVM = "0xa7e128326861d2eedc68ed82e2a5eb5f653a11a7";
const MARKET = "0xfecfc0bb57dd668ff37f2a232b208584e5feae53";
const SHARE = "0x0000000000000000000000000000000000a0289b";
const LP = "0x0000000000000000000000000000000000a03ae8";
const PERIPHERY = "0x0000000000000000000000000000000000a02731";
const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = Client.forMainnet().setOperator(OP_ID, PrivateKey.fromStringECDSA(OP_KEY));
async function cid(evm) {
  const lower = evm.replace(/^0x/, "").toLowerCase();
  if (lower.startsWith("00000000000000000000000000000000"))
    return ContractId.fromString(`0.0.${BigInt("0x" + lower).toString()}`);
  const r = await fetch(`${MIRROR}/api/v1/contracts/0x${lower}`);
  if (!r.ok) throw new Error(`mirror resolve fail ${evm}`);
  return ContractId.fromString((await r.json()).contract_id);
}

async function bal(token) {
  const num = BigInt(token).toString();
  const r = await fetch(`${MIRROR}/api/v1/accounts/${OP_EVM}/tokens?token.id=0.0.${num}&limit=1`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.tokens?.[0]?.balance ?? 0);
}
async function exec(label, contractEvm, fn, params, gas, payTinybar = 0) {
  const tx = new ContractExecuteTransaction()
    .setContractId(await cid(contractEvm)).setFunction(fn, params).setGas(gas)
    .setMaxTransactionFee(new Hbar(40));
  if (payTinybar > 0) tx.setPayableAmount(Hbar.fromTinybars(payTinybar.toString()));
  const res = await tx.execute(client);
  const rec = await res.getRecord(client);
  const hex = Buffer.from(rec.contractFunctionResult.bytes).toString("hex");
  const words = []; for (let i = 0; i < hex.length; i += 64) words.push(BigInt("0x" + hex.slice(i, i + 64)));
  console.log(`  ✓ ${label}  ${res.transactionId}`);
  return words;
}

(async () => {
  console.log(`Phase B supplement (operator ${OP_ID})\n`);

  // ── 1. claimAmmRewards(op) — headline feature, verify payout ──
  const shareBefore = await bal(SHARE);
  console.log(`SY-share before claim: ${shareBefore}`);
  const [ptAmount, ytAmount] = await exec(
    "claimAmmRewards(op)", MARKET, "claimAmmRewards",
    new ContractFunctionParameters().addAddress(OP_EVM.slice(2)), 900_000,
  );
  await sleep(8000);
  const shareAfter = await bal(SHARE);
  const delta = shareAfter - shareBefore;
  console.log(`  returned ptAmount = ${ptAmount}`);
  console.log(`  returned ytAmount = ${ytAmount}`);
  console.log(`  SY-share after    = ${shareAfter}  (delta +${delta})`);
  const claimOk = delta === ptAmount + ytAmount;
  console.log(`  VERIFY payout == returned (pt+yt): ${claimOk ? "PASS ✓" : "FAIL ✗"}  (${delta} vs ${ptAmount + ytAmount})`);
  // double-claim must be a no-op
  const [ptA2, ytA2] = await exec("claimAmmRewards(op) #2 (expect 0,0)", MARKET, "claimAmmRewards",
    new ContractFunctionParameters().addAddress(OP_EVM.slice(2)), 900_000);
  console.log(`  double-claim returns (${ptA2}, ${ytA2}): ${ptA2 === 0n && ytA2 === 0n ? "no-op PASS ✓" : "FAIL ✗"}\n`);

  // ── 2. buySyForLp — add LP (7-arg, the flow smoke skips) ──
  const lpBefore = await bal(LP);
  console.log(`LP before add: ${lpBefore}`);
  try {
    const syIn = 3_000_000n, ptShareBps = 5000, ptOutFromSwap = 1_500_000n, minLpOut = 1n;
    const [lpOut] = await exec(
      "buySyForLp(3 SY, 50% PT)", PERIPHERY, "buySyForLp",
      new ContractFunctionParameters()
        .addAddress(MARKET.slice(2)).addUint256(syIn.toString()).addUint16(ptShareBps)
        .addUint256(ptOutFromSwap.toString()).addUint256(minLpOut.toString())
        .addAddress(OP_EVM.slice(2)).addUint256("0"),
      14_000_000,
    );
    await sleep(8000);
    const lpAfter = await bal(LP);
    console.log(`  returned lpOut = ${lpOut}`);
    console.log(`  LP after add   = ${lpAfter}  (delta +${lpAfter - lpBefore})`);
    console.log(`  VERIFY lp minted > 0 and delta == lpOut: ${lpAfter - lpBefore === lpOut && lpOut > 0n ? "PASS ✓" : "FAIL ✗"}`);
  } catch (e) {
    console.log(`  buySyForLp FAILED: ${(e?.message ?? String(e)).slice(0, 240)}`);
  }

  const acct = await (await fetch(`${MIRROR}/api/v1/accounts/0.0.10495279`)).json();
  console.log(`\noperator HBAR after Phase B: ${(acct.balance.balance / 1e8).toFixed(2)}`);
  process.exit(0);
})();
