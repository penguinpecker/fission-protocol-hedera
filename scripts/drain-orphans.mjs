#!/usr/bin/env node
// drain-orphans.mjs — recover operator LP from 3 pre-canonical orphan markets.
//
// Strategy per orphan (operator owns ~100% of LP in each):
//   1. market.removeLiquidity(lpBal, 1, 1, operator)
//        → operator receives SY-share + PT
//   2. sy.redeemLiquidity(sharesReceived, 0, 0, operator)
//        → operator receives USDC + WHBAR from the V3 NPM position
//   3. PT stays in operator wallet for redeemAfterExpiry post-2026-08-25
//
// Recovered now: ~$1,682 USDC+WHBAR equivalent across 3 markets.
// PT redemption deferred to expiry (~$1,661 more).
//
// Env (loaded from repo root .env):
//   NEW_DEPLOYER_ID, NEW_DEPLOYER_KEY  — operator credentials
//
// Options:
//   DRY_RUN=1  — read state, print planned txs, no on-chain writes
//   ONLY=<mkt> — restrict to single market (substring match on address)

import {
  Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId,
  Hbar, PrivateKey,
} from "@hashgraph/sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

// ── env loader ─────────────────────────────────────────────────────────────
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
const ONLY = process.env.ONLY?.toLowerCase();

const OP_ID = process.env.NEW_DEPLOYER_ID;
const OP_KEY = process.env.NEW_DEPLOYER_KEY;
if (!OP_ID || !OP_KEY) throw new Error("missing NEW_DEPLOYER_ID or NEW_DEPLOYER_KEY in .env");
const OP_EVM = "0xa7e128326861d2eedc68ed82e2a5eb5f653a11a7";

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";

const ORPHANS = [
  {
    name: "Market 0x3aCDD09b (anchor=1.0 dead, ~$70)",
    market: "0x3acdd09b5850f551d9f2b4fe949439c2499f86c1",
    lp: "0x0000000000000000000000000000000000a0258b",
    sy: "0x0000000000000000000000000000000000a02585", // OLD SY adapter
  },
  {
    name: "Market 0x556938Ac (~$1,467)",
    market: "0x556938acfda70df2a32ea97e6b6862b874d93ef9",
    lp: "0x0000000000000000000000000000000000a025a1",
    sy: "0x0000000000000000000000000000000000a02585", // OLD SY adapter
  },
  {
    name: "Market 0x15DeA525 (~$146)",
    market: "0x15dea525b88e18c4696ccd358979477f7f52d4be",
    lp: "0x0000000000000000000000000000000000a0289f",
    sy: "0x0000000000000000000000000000000000a0289a", // CURRENT SY adapter
  },
];

const filtered = ONLY ? ORPHANS.filter((o) => o.market.includes(ONLY) || o.name.toLowerCase().includes(ONLY)) : ORPHANS;
if (!filtered.length) { console.error("No orphans matched ONLY=" + ONLY); process.exit(1); }

// ── Hedera client ──────────────────────────────────────────────────────────
const client = Client.forMainnet().setOperator(OP_ID, PrivateKey.fromStringECDSA(OP_KEY));
client.setDefaultMaxTransactionFee(new Hbar(20));

// ── helpers ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evmToEntity(evm) {
  const lower = evm.startsWith("0x") ? evm.slice(2).toLowerCase() : evm.toLowerCase();
  const r = await fetch(`${MIRROR}/api/v1/contracts/0x${lower}`);
  if (!r.ok) throw new Error(`mirror lookup failed for ${evm}: ${r.status}`);
  const j = await r.json();
  return j.contract_id; // "0.0.NUM"
}

async function tokenIdFromEvm(evm) {
  // For HTS tokens, EVM long-zero = 0x000...<num>
  const lower = evm.startsWith("0x") ? evm.slice(2).toLowerCase() : evm.toLowerCase();
  const num = BigInt("0x" + lower);
  return `0.0.${num}`;
}

async function readErc20Bal(token, holder) {
  // Mirror node for HTS balance (avoids the Ed25519/long-zero balanceOf revert).
  const tokenNum = (BigInt("0x" + token.slice(2).toLowerCase())).toString();
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}/tokens?token.id=0.0.${tokenNum}&limit=1`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.tokens?.[0]?.balance ?? 0);
}

async function readMarketState(o) {
  const lpBal = await readErc20Bal(o.lp, OP_EVM);
  // We don't know SY shareToken / PT addresses yet — read them off the market on first call.
  return { lp: lpBal };
}

async function exec(contractIdStr, fnName, params, gas, payableTinybar = 0) {
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractIdStr))
    .setFunction(fnName, params)
    .setGas(gas);
  if (payableTinybar > 0) tx.setPayableAmount(Hbar.fromTinybars(payableTinybar));
  if (DRY_RUN) {
    console.log(`  [DRY] ${contractIdStr}.${fnName}(...) gas=${gas}`);
    return null;
  }
  const res = await tx.execute(client);
  const rec = await res.getReceipt(client);
  console.log(`  ✓ tx=${res.transactionId.toString()}  status=${rec.status.toString()}`);
  return { txId: res.transactionId.toString(), status: rec.status.toString() };
}

// ── per-market driver ──────────────────────────────────────────────────────
async function drainOne(o) {
  console.log(`\n━━━ ${o.name} ━━━`);
  console.log(`market: ${o.market}`);
  console.log(`lp:     ${o.lp}`);
  console.log(`sy:     ${o.sy}`);

  const marketEntity = await evmToEntity(o.market);
  const syEntity = await evmToEntity(o.sy);
  console.log(`market entity: ${marketEntity}  |  sy entity: ${syEntity}`);

  // Resolve this SY's shareToken first — for markets using current SY adapter
  // (0x...A0289A), shareToken = 0x...A0289B which is ALSO the canonical market's
  // SY token. Operator likely already holds canonical-market shares; we must
  // only redeem the DELTA from this orphan's removeLiquidity, never the total.
  const shareEvmHex = await (async () => {
    const r = await fetch("https://mainnet.hashio.io/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: o.sy, data: "0x6c9fa59e" /* shareToken() */ }, "latest"],
      }),
    });
    const j = await r.json();
    return "0x" + (j.result ?? "").slice(-40);
  })();
  console.log(`shareToken: ${shareEvmHex}`);

  const lpBal = await readErc20Bal(o.lp, OP_EVM);
  const shareBalBefore = await readErc20Bal(shareEvmHex, OP_EVM);
  console.log(`operator LP balance:     ${lpBal}`);
  console.log(`operator SY-share BEFORE: ${shareBalBefore}  (will not touch this)`);
  if (lpBal === 0n) { console.log("→ skip (zero LP)"); return; }

  // STEP 1: removeLiquidity(lpIn, minSyOut=1, minPtOut=1, receiver=operator)
  console.log(`\nStep 1: market.removeLiquidity(${lpBal}, 1, 1, operator)`);
  await exec(
    marketEntity,
    "removeLiquidity",
    new ContractFunctionParameters()
      .addUint256(lpBal.toString())
      .addUint256("1")
      .addUint256("1")
      .addAddress(OP_EVM.slice(2)),
    3_000_000,
  );
  if (!DRY_RUN) await sleep(8000);

  const shareBalAfter = await readErc20Bal(shareEvmHex, OP_EVM);
  const sharesReceived = shareBalAfter - shareBalBefore;
  console.log(`operator SY-share AFTER:  ${shareBalAfter}`);
  console.log(`SY-share delta (= shares to redeem): ${sharesReceived}`);
  if (sharesReceived <= 0n) {
    console.log("→ no SY shares received from this market — skipping redeemLiquidity");
    return;
  }

  // STEP 2: redeem ONLY the delta — never the operator's pre-existing balance.
  console.log(`\nStep 2: sy.redeemLiquidity(${sharesReceived}, 0, 0, operator)`);
  await exec(
    syEntity,
    "redeemLiquidity",
    new ContractFunctionParameters()
      .addUint256(sharesReceived.toString())
      .addUint256("0")
      .addUint256("0")
      .addAddress(OP_EVM.slice(2)),
    5_000_000,
  );
  if (!DRY_RUN) await sleep(8000);

  // Report final shareBal — should match shareBalBefore (we burned the delta).
  const shareBalFinal = await readErc20Bal(shareEvmHex, OP_EVM);
  console.log(`operator SY-share FINAL:  ${shareBalFinal}  (target: ${shareBalBefore})`);
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`drain-orphans.mjs  (DRY_RUN=${DRY_RUN}, ONLY=${ONLY ?? "all"})`);
  console.log(`operator: ${OP_ID}  /  ${OP_EVM}`);
  console.log(`targets: ${filtered.length}`);
  for (const o of filtered) {
    try { await drainOne(o); }
    catch (e) { console.error(`!! ${o.name}: ${e?.message ?? e}`); }
  }
  console.log("\nDone.");
  process.exit(0);
})();
