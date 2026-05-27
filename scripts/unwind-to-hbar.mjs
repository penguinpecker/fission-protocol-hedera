#!/usr/bin/env node
// unwind-to-hbar.mjs — convert operator's USDC + WHBAR balances back to native HBAR.
//
// Steps:
//   1. Approve V2 router to spend operator's USDC (HTS allowance, int64.max).
//   2. V2 router exactInputSingle(USDC → WHBAR @ 0.15% pool fee=1500).
//   3. WHBAR_CONTRACT.withdraw(allWHBAR balance) → native HBAR back.
//
// All txs from operator-keyed account 0.0.10495279.
//
// Env (loaded from repo root .env):
//   NEW_DEPLOYER_ID, NEW_DEPLOYER_KEY
//
// Options:
//   DRY_RUN=1   — read state, print planned actions, no on-chain writes
//   SKIP_SWAP=1 — skip USDC→WHBAR swap, only unwrap existing WHBAR

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
const SKIP_SWAP = process.env.SKIP_SWAP === "1" || process.env.SKIP_SWAP === "true";

const OP_ID = process.env.NEW_DEPLOYER_ID;
const OP_KEY = process.env.NEW_DEPLOYER_KEY;
if (!OP_ID || !OP_KEY) throw new Error("missing NEW_DEPLOYER_ID or NEW_DEPLOYER_KEY in .env");
const OP_EVM = "0xa7e128326861d2eedc68ed82e2a5eb5f653a11a7";

const USDC = "0x000000000000000000000000000000000006f89a";
const WHBAR_TOKEN = "0x0000000000000000000000000000000000163b5a";
const WHBAR_CONTRACT = "0x0000000000000000000000000000000000163b59";
const V2_ROUTER = "0x00000000000000000000000000000000003c437a";
const POOL_FEE = 1500; // 0.15% — the USDC/WHBAR pool

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const MAX_HTS_APPROVE = ((1n << 63n) - 1n).toString(); // int64.max
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = Client.forMainnet().setOperator(OP_ID, PrivateKey.fromStringECDSA(OP_KEY));
client.setDefaultMaxTransactionFee(new Hbar(20));

async function evmToEntity(evm) {
  const lower = evm.startsWith("0x") ? evm.slice(2).toLowerCase() : evm.toLowerCase();
  // Long-zero EVM addresses are direct entity-ID encodings: take the numeric
  // suffix → 0.0.<num>. Works for both HTS tokens and Hedera-deployed contracts.
  if (lower.startsWith("00000000000000000000000000000000")) {
    const num = BigInt("0x" + lower).toString();
    return `0.0.${num}`;
  }
  // Non-long-zero (e.g. EVM-deployed contract via Hashio create) → resolve via Mirror.
  const r = await fetch(`${MIRROR}/api/v1/contracts/0x${lower}`);
  if (!r.ok) throw new Error(`mirror lookup failed for ${evm}: ${r.status}`);
  const j = await r.json();
  return j.contract_id;
}

async function tokenBalance(token, holder) {
  const tokenNum = (BigInt("0x" + token.slice(2).toLowerCase())).toString();
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}/tokens?token.id=0.0.${tokenNum}&limit=1`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.tokens?.[0]?.balance ?? 0);
}

async function nativeHbar(holder) {
  const r = await fetch(`${MIRROR}/api/v1/accounts/${holder}`);
  if (!r.ok) return 0n;
  const j = await r.json();
  return BigInt(j?.balance?.balance ?? 0);
}

async function exec(label, contractIdStr, fnName, params, gas, payable = 0, rawCalldata = null) {
  if (DRY_RUN) {
    console.log(`  [DRY] ${label}`);
    return null;
  }
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractIdStr))
    .setGas(gas);
  if (rawCalldata) tx.setFunctionParameters(rawCalldata);
  else tx.setFunction(fnName, params);
  if (payable > 0) tx.setPayableAmount(Hbar.fromTinybars(payable));
  const res = await tx.execute(client);
  const rec = await res.getReceipt(client);
  console.log(`  ✓ ${label}  tx=${res.transactionId.toString()}  status=${rec.status.toString()}`);
  return res.transactionId.toString();
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`unwind-to-hbar.mjs  (DRY_RUN=${DRY_RUN}, SKIP_SWAP=${SKIP_SWAP})`);
  console.log(`operator: ${OP_ID}  /  ${OP_EVM}\n`);

  const usdcStart = await tokenBalance(USDC, OP_EVM);
  const whbarStart = await tokenBalance(WHBAR_TOKEN, OP_EVM);
  const hbarStart = await nativeHbar(OP_EVM);
  console.log(`Before:`);
  console.log(`  USDC:  ${usdcStart}  ($${Number(usdcStart) / 1e6})`);
  console.log(`  WHBAR: ${whbarStart}  (${Number(whbarStart) / 1e8} WHBAR)`);
  console.log(`  HBAR:  ${hbarStart}  (${Number(hbarStart) / 1e8} HBAR)\n`);

  // STEP 1 + 2: swap USDC → WHBAR via V2 router
  if (!SKIP_SWAP && usdcStart > 0n) {
    const usdcEntity = await evmToEntity(USDC);
    const routerEntity = await evmToEntity(V2_ROUTER);
    console.log(`USDC token entity: ${usdcEntity}, router entity: ${routerEntity}`);

    // Step 1: approve router to spend USDC (HTS allowance)
    console.log(`\n[1] USDC.approve(${V2_ROUTER}, int64.max)`);
    await exec(
      "approve V2 router for USDC",
      usdcEntity,
      "approve",
      new ContractFunctionParameters()
        .addAddress(V2_ROUTER.slice(2))
        .addUint256(MAX_HTS_APPROVE),
      1_000_000,
    );
    if (!DRY_RUN) await sleep(4000);

    // Step 2: exactInputSingle(USDC → WHBAR, fee=1500)
    // Selector 0x414bf389 = exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
    // SwapRouter01 form (8 fields including deadline).
    const deadline = (Math.floor(Date.now() / 1000) + 600).toString();
    const pad = (h, n = 64) => h.replace(/^0x/, "").padStart(n, "0");
    const enc = (vals, types) =>
      Buffer.from(
        vals.map((v, i) => {
          if (types[i] === "address") return pad(v.toLowerCase().replace(/^0x/, ""));
          return pad(BigInt(v).toString(16));
        }).join(""),
        "hex",
      );
    const tuple = enc(
      [WHBAR_TOKEN.toLowerCase(), USDC.toLowerCase(), POOL_FEE.toString(), OP_EVM, deadline, usdcStart.toString(), "0", "0"],
      ["address", "address", "uint24", "address", "uint256", "uint256", "uint256", "uint160"],
    );
    // Wait — we want USDC → WHBAR, so tokenIn=USDC, tokenOut=WHBAR
    const tupleCorrected = enc(
      [USDC.toLowerCase(), WHBAR_TOKEN.toLowerCase(), POOL_FEE.toString(), OP_EVM, deadline, usdcStart.toString(), "0", "0"],
      ["address", "address", "uint24", "address", "uint256", "uint256", "uint256", "uint160"],
    );
    const selector = Buffer.from("414bf389", "hex");
    const calldata = Buffer.concat([selector, tupleCorrected]);

    console.log(`\n[2] router.exactInputSingle(USDC→WHBAR, amountIn=${usdcStart}, fee=${POOL_FEE})`);
    await exec(
      "V2 swap USDC→WHBAR",
      routerEntity,
      null,
      null,
      2_500_000,
      0,
      calldata,
    );
    if (!DRY_RUN) await sleep(6000);
  } else if (usdcStart === 0n) {
    console.log("[1+2] No USDC to swap — skipping.");
  } else {
    console.log("[1+2] SKIP_SWAP=1 — skipping USDC→WHBAR.");
  }

  // STEP 3: approve WHBAR_CONTRACT for WHBAR + withdraw → native HBAR.
  // HTS WHBAR uses transferFrom under the hood — needs HTS allowance from
  // operator to the WHBAR wrapper. (Different from WETH9 where msg.sender's
  // own balanceOf is just decremented.)
  const whbarNow = await tokenBalance(WHBAR_TOKEN, OP_EVM);
  if (whbarNow > 0n) {
    const whbarTokenEntity = await evmToEntity(WHBAR_TOKEN);
    const whbarWrapperEntity = await evmToEntity(WHBAR_CONTRACT);

    console.log(`\n[3a] WHBAR_TOKEN.approve(${WHBAR_CONTRACT}, int64.max)`);
    await exec(
      "approve WHBAR wrapper",
      whbarTokenEntity,
      "approve",
      new ContractFunctionParameters()
        .addAddress(WHBAR_CONTRACT.slice(2))
        .addUint256(MAX_HTS_APPROVE),
      1_000_000,
    );
    if (!DRY_RUN) await sleep(4000);

    console.log(`\n[3b] WHBAR_CONTRACT.withdraw(${whbarNow})  // unwrap to native HBAR`);
    await exec(
      "WHBAR unwrap",
      whbarWrapperEntity,
      "withdraw",
      new ContractFunctionParameters().addUint256(whbarNow.toString()),
      1_500_000,
    );
    if (!DRY_RUN) await sleep(6000);
  } else {
    console.log("[3] No WHBAR to unwrap.");
  }

  const usdcEnd = await tokenBalance(USDC, OP_EVM);
  const whbarEnd = await tokenBalance(WHBAR_TOKEN, OP_EVM);
  const hbarEnd = await nativeHbar(OP_EVM);
  console.log(`\nAfter:`);
  console.log(`  USDC:  ${usdcEnd}  ($${Number(usdcEnd) / 1e6})`);
  console.log(`  WHBAR: ${whbarEnd}  (${Number(whbarEnd) / 1e8} WHBAR)`);
  console.log(`  HBAR:  ${hbarEnd}  (${Number(hbarEnd) / 1e8} HBAR)`);
  console.log(`\n  Net HBAR gained: ${Number(hbarEnd - hbarStart) / 1e8} HBAR`);
  process.exit(0);
})();
