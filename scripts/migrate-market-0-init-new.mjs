#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  migrate-market-0-init-new.mjs — Phase 3 of the migration.
// ════════════════════════════════════════════════════════════════════════════
//
//  Pre-conditions:
//    - Phase 1 (drain) has been run → operator holds clean SY-shares + 0 PT/YT.
//    - Phase 2 (redeploy) has been run → deployments/295.json has new factory
//      + deployers + market entries under `markets[1+]` AND old market 0 has
//      been moved to `abandoned.old_markets`.
//
//  This script:
//    1. Reads the NEW market entry from deployments/295.json
//    2. Splits half of operator's SY-share into PT+YT on the new market
//    3. seedBurnYt residual YT (we only need PT to seed the AMM)
//    4. initialize(syIn, ptIn, anchor, lnFeeRate, reservePct) on the new market
//
//  Env:
//    NEW_MARKET=0x…           (override default: reads deployments JSON)
//    NEW_MARKET_ENTITY=0.0.X
//    SEED_SHARE_FRACTION=0.95 (fraction of operator SY-shares to seed; default 95%)
//    INITIAL_ANCHOR_E18=1020000000000000000
//    LN_FEE_RATE_ROOT_E18=300000000000000
//    RESERVE_FEE_PERCENT=80
//    DRY_RUN=1

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

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const SY_SHARE_ENTITY = process.env.SY_SHARE_ENTITY || "0.0.10465419";

const deploymentsPath = join(REPO, "deployments", "295.json");
const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));

// New market: explicit env override, otherwise the LAST entry in markets[] that
// is NOT the old broken market 0.
let newMarket = null;
const newMarketEvm = (process.env.NEW_MARKET || "").toLowerCase();
const newMarketEntity = process.env.NEW_MARKET_ENTITY;
if (newMarketEvm) {
  newMarket = { evm: newMarketEvm, entityId: newMarketEntity };
} else {
  // Pick the newest market entry that's NOT the abandoned one
  for (const m of deployments.markets) {
    if (m.evm?.toLowerCase() !== "0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d") newMarket = m;
  }
  if (!newMarket) throw new Error("No new market in deployments/295.json — run Phase 2 first.");
}

const NEW_MARKET_EVM = newMarket.evm.toLowerCase();
const NEW_MARKET_ENTITY = newMarket.entityId || newMarket.id;
if (!NEW_MARKET_ENTITY) {
  throw new Error("New market entry missing entityId/id — set NEW_MARKET_ENTITY env explicitly.");
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const operatorEvm = ("0x" + operatorKey.publicKey.toEvmAddress()).toLowerCase();

let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const res = await fetch(`${MIRROR}/api/v1/accounts/${operatorEvm}`);
  operatorIdStr = (await res.json()).account;
}

const SEED_FRACTION = Number(process.env.SEED_SHARE_FRACTION ?? "0.95");
const INITIAL_ANCHOR = process.env.INITIAL_ANCHOR_E18 ?? "1020000000000000000"; // 1.02e18
const LN_FEE = process.env.LN_FEE_RATE_ROOT_E18 ?? "300000000000000";            // 3e14
const RESERVE = process.env.RESERVE_FEE_PERCENT ?? "80";

console.log(`Operator:        ${operatorIdStr}  evm=${operatorEvm}`);
console.log(`New market:      ${NEW_MARKET_ENTITY}  evm=${NEW_MARKET_EVM}`);
console.log(`Seed fraction:   ${(SEED_FRACTION * 100).toFixed(1)}% of operator's SY-share balance`);
console.log(`Initial anchor:  ${INITIAL_ANCHOR}`);
console.log(`Mode:            ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
console.log();

const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);
client.setDefaultMaxTransactionFee(new Hbar(5));

async function balance(tokenEntity, accountEntity) {
  const res = await fetch(`${MIRROR}/api/v1/accounts/${accountEntity}/tokens?token.id=${tokenEntity}`);
  const data = await res.json();
  const entry = (data.tokens || []).find((t) => t.token_id === tokenEntity);
  return entry ? BigInt(entry.balance) : 0n;
}

async function exec(targetEntity, fnName, params, gas = 1_500_000) {
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] would call ${fnName} on ${targetEntity} (gas=${gas})`);
    return { dryRun: true };
  }
  const tx = await new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(targetEntity))
    .setGas(gas)
    .setFunction(fnName, params)
    .execute(client);
  const r = await tx.getReceipt(client);
  console.log(`  ✓ ${fnName}: ${tx.transactionId.toString()}  status=${r.status.toString()}`);
  return { txId: tx.transactionId.toString() };
}

async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)); }

// ── pre-flight ─────────────────────────────────────────────────────────────
const syBefore = await balance(SY_SHARE_ENTITY, operatorIdStr);
console.log(`Operator SY-share balance: ${syBefore.toLocaleString()} raw`);
if (syBefore === 0n) {
  console.error("Operator has 0 SY-shares — did Phase 1 (drain) complete? Aborting.");
  process.exit(1);
}

const seedShares = (syBefore * BigInt(Math.floor(SEED_FRACTION * 10000))) / 10000n;
const splitHalf = seedShares / 2n; // half → PT+YT, half kept as SY for the LP-side seed

console.log(`Seeding new market with ${seedShares.toLocaleString()} SY-shares`);
console.log(`  → split ${splitHalf.toLocaleString()} into PT+YT`);
console.log(`  → use ${splitHalf.toLocaleString()} SY + ${splitHalf.toLocaleString()} PT for initialize`);
console.log();

// ── Step 1: approve SY-share to new market ─────────────────────────────────
const SY_SHARE_EVM = "0x" + Number(SY_SHARE_ENTITY.split(".").pop()).toString(16).padStart(40, "0");
console.log(`Step 1: approve SY-share to new market`);
await exec(
  SY_SHARE_ENTITY,
  "approve",
  new ContractFunctionParameters()
    .addAddress(NEW_MARKET_EVM.slice(2))
    .addUint256(seedShares.toString()),
  800_000,
);
if (!DRY_RUN) await sleep(4000);

// ── Step 2: split half SY-share into PT+YT on the new market ───────────────
console.log(`\nStep 2: split(${splitHalf.toLocaleString()}) on new market`);
await exec(
  NEW_MARKET_ENTITY,
  "split",
  new ContractFunctionParameters().addUint256(splitHalf.toString()),
  2_000_000,
);
if (!DRY_RUN) await sleep(6000);

// ── Step 3: seedBurnYt residual YT (only PT needed for initialize) ─────────
console.log(`\nStep 3: seedBurnYt(${splitHalf.toLocaleString()}) on new market (dispose of residual YT)`);
await exec(
  NEW_MARKET_ENTITY,
  "seedBurnYt",
  new ContractFunctionParameters().addUint256(splitHalf.toString()),
  1_500_000,
);
if (!DRY_RUN) await sleep(4000);

// ── Step 4: approve PT to new market (split sends PT to msg.sender) ────────
// PT token entity is in the new market's deployment entry.
const NEW_PT_ENTITY = newMarket.pt_entity || newMarket.pt; // accept either key
if (!NEW_PT_ENTITY) {
  throw new Error("deployments JSON missing new market's pt token entityId. Add `pt_entity: \"0.0.X\"` to the market entry.");
}
console.log(`\nStep 4: approve PT to new market`);
await exec(
  NEW_PT_ENTITY,
  "approve",
  new ContractFunctionParameters()
    .addAddress(NEW_MARKET_EVM.slice(2))
    .addUint256(splitHalf.toString()),
  800_000,
);
if (!DRY_RUN) await sleep(4000);

// ── Step 5: initialize new market with (splitHalf SY, splitHalf PT) ────────
console.log(`\nStep 5: initialize(${splitHalf}, ${splitHalf}, anchor=${INITIAL_ANCHOR}, lnFee=${LN_FEE}, reserve=${RESERVE}%)`);
await exec(
  NEW_MARKET_ENTITY,
  "initialize",
  new ContractFunctionParameters()
    .addUint256(splitHalf.toString())
    .addUint256(splitHalf.toString())
    .addInt256(INITIAL_ANCHOR)
    .addInt256(LN_FEE)
    .addUint256(RESERVE),
  3_500_000,
);
if (!DRY_RUN) await sleep(6000);

const syAfter = await balance(SY_SHARE_ENTITY, operatorIdStr);
console.log(`\nDone. Operator SY-share after init: ${syAfter.toLocaleString()} raw (was ${syBefore.toLocaleString()})`);
console.log();
console.log("Next steps:");
console.log("  1. Apply supabase migration to mark old market archived");
console.log("  2. Update frontend addresses.ts to point at the new market");
console.log("  3. Trigger indexer cron once: POST /api/markets/refresh");
