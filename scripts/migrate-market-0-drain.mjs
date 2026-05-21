#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  migrate-market-0-drain.mjs — Phase 1 of the Market 0 → fixed-market migration.
// ════════════════════════════════════════════════════════════════════════════
//
//  Drains operator's position from the LIVE-BUT-BROKEN Market 0 (Ed25519
//  reward-accrual bug, see audits/internal/SECURITY_REVIEW_ED25519_BAL_2026-05-22.md).
//
//  Steps (operator-only — cosigner B's position is hers to migrate):
//    1. removeLiquidity(operator_LP_full)  → operator gets back SY-share + PT
//    2. merge(min(PT, YT))                 → burns matching pairs into SY-share
//    3. seedBurnYt(residual YT)            → wipes operator's leftover YT (admin op)
//    4. swapExactPtForSy(residual PT)      → sells any residual PT for SY-share
//
//  Output: operator ends up holding only SY-shares + a clean ledger. Those SY-shares
//  carry the full V3-NFT-backed value (USDC + WHBAR) and will seed the new market.
//
//  DOES NOT deploy the new market or migrate cosigner B's position.
//  Cosigner B can do her own removeLiquidity / merge / sell PT at her leisure;
//  her Ed25519 facade-balanceOf returns 0 silently inside merge() but doesn't
//  brick her exit — she just forfeits ~$0.005 of accrued rewards.
//
//  Env:
//    DRY_RUN=1   — read state, print intended actions, no on-chain writes
//    MARKET=0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d   (override default)
//    HEDERA_DERIVATION_PATH=m/44'/3030'/0'/0/0           (operator key path)
//
//  Pre-flight assumption: operator's account already holds enough HBAR for gas
//  (each step is ~0.3-1.0 HBAR; ~5 HBAR buffer is plenty).

import {
  Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId,
  Hbar, PrivateKey,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

function loadDotenv() {
  const envPath = join(REPO, ".env");
  if (!existsSync(envPath)) return;
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

function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}

// ── config ─────────────────────────────────────────────────────────────────
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const MARKET_EVM = (process.env.MARKET || "0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d").toLowerCase();
const MARKET_ENTITY = process.env.MARKET_ENTITY || "0.0.10465460";
const PT_ENTITY = process.env.PT_ENTITY || "0.0.10465461";  // 0x...009fb0b5
const YT_ENTITY = process.env.YT_ENTITY || "0.0.10465462";  // 0x...009fb0b6
const LP_ENTITY = process.env.LP_ENTITY || "0.0.10465463";  // 0x...009fb0b7

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";

// ── operator setup ─────────────────────────────────────────────────────────
const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const operatorEvm = ("0x" + operatorKey.publicKey.toEvmAddress()).toLowerCase();

let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const res = await fetch(`${MIRROR}/api/v1/accounts/${operatorEvm}`);
  if (!res.ok) throw new Error(`Mirror lookup failed: HTTP ${res.status}`);
  operatorIdStr = (await res.json()).account;
}
console.log(`Operator: ${operatorIdStr}  evm=${operatorEvm}`);
console.log(`Market:   ${MARKET_ENTITY}  evm=${MARKET_EVM}`);
console.log(`Mode:     ${DRY_RUN ? "DRY-RUN (no writes)" : "LIVE"}`);
console.log();

const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(5));

// ── helpers ────────────────────────────────────────────────────────────────
async function balance(tokenEntity, accountEntity) {
  const res = await fetch(`${MIRROR}/api/v1/accounts/${accountEntity}/tokens?token.id=${tokenEntity}`);
  if (!res.ok) throw new Error(`mirror lookup failed: ${res.status}`);
  const data = await res.json();
  const entry = (data.tokens || []).find((t) => t.token_id === tokenEntity);
  return entry ? BigInt(entry.balance) : 0n;
}

function fmt(raw, dec = 18) {
  const s = raw.toString();
  return `${raw.toLocaleString()} raw`;
}

async function exec(targetEntity, fnName, params, gas = 1_200_000, hbarValue = 0) {
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] would call ${fnName} on ${targetEntity} (gas=${gas}, hbar=${hbarValue})`);
    return { dryRun: true };
  }
  const tx = await new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(targetEntity))
    .setGas(gas)
    .setFunction(fnName, params)
    .setPayableAmount(new Hbar(hbarValue))
    .execute(client);
  const r = await tx.getReceipt(client);
  console.log(`  ✓ ${fnName}: ${tx.transactionId.toString()}  status=${r.status.toString()}`);
  return { txId: tx.transactionId.toString(), status: r.status.toString() };
}

// Mirror node lag: after a HAPI tx, mirror needs a few seconds to reflect new balances.
async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// ── pre-flight state ───────────────────────────────────────────────────────
async function readState(tag) {
  const [pt, yt, lp] = await Promise.all([
    balance(PT_ENTITY, operatorIdStr),
    balance(YT_ENTITY, operatorIdStr),
    balance(LP_ENTITY, operatorIdStr),
  ]);
  console.log(`State @ ${tag}:`);
  console.log(`  operator PT raw = ${pt.toLocaleString()}`);
  console.log(`  operator YT raw = ${yt.toLocaleString()}`);
  console.log(`  operator LP raw = ${lp.toLocaleString()}`);
  return { pt, yt, lp };
}

const initial = await readState("pre-drain");
console.log();

if (initial.lp === 0n && initial.pt === 0n && initial.yt === 0n) {
  console.log("Operator holds nothing to migrate. Exiting.");
  process.exit(0);
}

// ── Step 1: removeLiquidity ────────────────────────────────────────────────
if (initial.lp > 0n) {
  console.log(`Step 1: removeLiquidity(lpIn=${initial.lp.toLocaleString()}, minSyOut=1, minPtOut=1, receiver=operator)`);
  await exec(
    MARKET_ENTITY,
    "removeLiquidity",
    new ContractFunctionParameters()
      .addUint256(initial.lp.toString())
      .addUint256("1")          // minSyOut = floor; we accept whatever
      .addUint256("1")          // minPtOut = floor
      .addAddress(operatorEvm.slice(2)),
    2_000_000,
  );
  if (!DRY_RUN) await sleep(6000);
} else {
  console.log("Step 1: skipped (no LP to remove)");
}
console.log();

const afterLp = await readState("after removeLiquidity");
console.log();

// ── Step 2: merge as many PT+YT pairs as possible ──────────────────────────
const mergeAmount = afterLp.pt < afterLp.yt ? afterLp.pt : afterLp.yt;
if (mergeAmount > 0n) {
  console.log(`Step 2: merge(${mergeAmount.toLocaleString()})  // burns matching PT+YT → SY-share`);
  await exec(
    MARKET_ENTITY,
    "merge",
    new ContractFunctionParameters().addUint256(mergeAmount.toString()),
    2_000_000,
  );
  if (!DRY_RUN) await sleep(6000);
} else {
  console.log("Step 2: skipped (no matching PT+YT pairs)");
}
console.log();

const afterMerge = await readState("after merge");
console.log();

// ── Step 3: seedBurnYt residual YT (admin op) ──────────────────────────────
// Option-2 from migration plan: wipe operator's residual YT directly. Forfeits
// ~$0.70 of forgone future yield in exchange for clean state. Admin-gated;
// operator must hold ADMIN_ROLE on this Market (they do — they're solo admin
// pre-handoff).
if (afterMerge.yt > 0n) {
  console.log(`Step 3: seedBurnYt(${afterMerge.yt.toLocaleString()})  // admin-wipe residual YT`);
  await exec(
    MARKET_ENTITY,
    "seedBurnYt",
    new ContractFunctionParameters().addUint256(afterMerge.yt.toString()),
    1_500_000,
  );
  if (!DRY_RUN) await sleep(6000);
} else {
  console.log("Step 3: skipped (no residual YT)");
}
console.log();

const afterBurn = await readState("after seedBurnYt");
console.log();

// ── Step 4: swapExactPtForSy residual PT (if any) ──────────────────────────
// After merge, operator should have ≈0 PT, but tiny rounding residue can stay.
// Sell it via the existing router (or skip if zero).
if (afterBurn.pt > 0n) {
  console.log(`Step 4: swapExactPtForSy(${afterBurn.pt.toLocaleString()}, 0, receiver=operator)  // dispose dust PT`);
  // Call market directly (router redeploy not required for residual dust)
  await exec(
    MARKET_ENTITY,
    "swapExactPtForSy",
    new ContractFunctionParameters()
      .addUint256(afterBurn.pt.toString())
      .addUint256("0")
      .addAddress(operatorEvm.slice(2)),
    2_000_000,
  );
  if (!DRY_RUN) await sleep(6000);
} else {
  console.log("Step 4: skipped (no PT dust to sell)");
}
console.log();

const final = await readState("post-drain (operator should be clean)");
console.log();

if (DRY_RUN) {
  console.log("DRY-RUN complete. Set DRY_RUN=0 (or remove) and re-run to execute on mainnet.");
} else {
  console.log("Drain complete. Next steps:");
  console.log("  1. Verify operator's SY-share balance on mirror node");
  console.log("  2. Deploy new contract set (deploy-mainnet-sdk.mjs with FIX_REDEPLOY=1)");
  console.log("  3. Run migrate-market-0-init-new.mjs to initialize the new market");
}
