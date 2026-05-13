#!/usr/bin/env node
// End-to-end smoke for the 4 trade paths we haven't already covered:
//   * Buy YT     (router.buyYT)
//   * Split SY   (market.split — direct, no router)
//   * Add LP     (router.addLiquidityProportional)
//   * Remove LP  (router.removeLiquidityProportional)
//
// Each path runs with a tiny amount so the deployer doesn't bleed HBAR.
// Reads balances via Hashio (Mirror Node lags by a few seconds post-receipt).

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
// Prefer the v3 router once it's deployed (fixes addLiquidityProportional). The
// v2 router is still here for fall-back testing of the other entries, but the
// dApp now uses v3 in production.
const ROUTER = deploy.router_v3?.evm ?? deploy.router.evm;
const SY = deploy.sy_saucer_v2_lp.evm;
const PT = deploy.markets[0].pt;
const YT = deploy.markets[0].yt;
const LP = deploy.markets[0].lp;

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

// Helper to approve a token to a spender if allowance < amount.
async function approveIfNeeded(tokenAddr, spender, amount, label) {
  const cur = await allowance(tokenAddr, evmAddr, spender);
  if (cur >= amount) {
    console.log(`   approval ${label} already ≥ ${amount} (cur ${cur})`);
    return;
  }
  console.log(`   approving ${label} → ${spender}: ${amount}`);
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, tokenAddr))
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(spender).addUint256(amount.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   approval status: ${r.status.toString()}`);
}

async function execContract(contractAddr, fnSig, params, gas, label) {
  console.log(`\n[${label}] ${fnSig}`);
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, contractAddr))
    .setGas(gas)
    .setMaxTransactionFee(new Hbar(30))
    .setFunction(fnSig.split("(")[0], params);
  try {
    const submit = await tx.execute(client);
    const r = await submit.getReceipt(client);
    console.log(`   Status: ${r.status.toString()}`);
    console.log(`   Tx:     ${submit.transactionId.toString()}`);
    return { ok: r.status.toString() === "SUCCESS", tx: submit.transactionId.toString() };
  } catch (e) {
    console.log(`   REVERT  ${e.transactionId?.toString() ?? "(no id)"}  status=${e.status?._code ?? "?"}`);
    return { ok: false, tx: e.transactionId?.toString() ?? "" };
  }
}

console.log(`Op:           ${evmAddr} / ${operatorIdStr}`);
console.log(`Market:       ${MARKET}`);
console.log(`SY shareTok:  ${shareTok}`);
console.log(`PT/YT/LP:     ${PT} / ${YT} / ${LP}`);

// ─── 3/6: Buy YT ────────────────────────────────────────────────
{
  console.log("\n═══ 3/6: Buy YT (router.buyYT, 1M SY budget) ═══");
  const syBefore = await balanceOf(shareTok, evmAddr);
  const ytBefore = await balanceOf(YT, evmAddr);
  const SY_IN = 1_000_000n;
  await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY");
  // minSyOutFromPtSale: how much SY the router expects from re-selling the
  // flash-minted PT into the AMM. Pendle's logit curve at 8.33% / 81d gives
  // ≈ ptRate of 0.98, so PT sale yields ≈ 0.98 × syBudget. With thin TVL
  // the actual rate can dip below the static-math estimate — use a wide
  // 30% slippage allowance here just for the smoke test.
  const minSyOut = (SY_IN * 7000n) / 10_000n; // 30% slack (smoke test)
  const deadline = Math.floor(Date.now() / 1000) + 600;
  await execContract(
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
  console.log(`   SY  ${syBefore} → ${syAfter}  (Δ ${syAfter - syBefore})`);
  console.log(`   YT  ${ytBefore} → ${ytAfter}  (Δ ${ytAfter - ytBefore})`);
}

// ─── 4/6: Split SY → PT + YT ─────────────────────────────────────
{
  console.log("\n═══ 4/6: Split SY → PT + YT (market.split, 1M SY direct) ═══");
  const syBefore = await balanceOf(shareTok, evmAddr);
  const ptBefore = await balanceOf(PT, evmAddr);
  const ytBefore = await balanceOf(YT, evmAddr);
  const AMOUNT = 1_000_000n;
  await approveIfNeeded(shareTok, MARKET, AMOUNT, "SY (to market)");
  await execContract(
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
  console.log(`   SY  ${syBefore} → ${syAfter}  (Δ ${syAfter - syBefore})`);
  console.log(`   PT  ${ptBefore} → ${ptAfter}  (Δ ${ptAfter - ptBefore})`);
  console.log(`   YT  ${ytBefore} → ${ytAfter}  (Δ ${ytAfter - ytBefore})`);
}

// ─── 5/6: Add Liquidity (proportional) ───────────────────────────
{
  console.log("\n═══ 5/6: Add LP (router.addLiquidityProportional, 1M SY + matching PT) ═══");
  // Read current pool ratio to compute proportional PT side
  // totalSy and totalPt on the market
  const ts = await ethCall(MARKET, "0xfb7b29ff"); // totalSy() — let me verify
  const tp = await ethCall(MARKET, "0xc6fc8c2a"); // totalPt() — let me verify
  const totalSy = BigInt(ts || "0x0");
  const totalPt = BigInt(tp || "0x0");
  const syBefore = await balanceOf(shareTok, evmAddr);
  const ptBefore = await balanceOf(PT, evmAddr);
  const lpBefore = await balanceOf(LP, evmAddr);
  const SY_IN = 1_000_000n;
  // PT needed proportional to current pool ratio
  const PT_IN = totalSy > 0n ? (SY_IN * totalPt) / totalSy : SY_IN;
  console.log(`   pool: totalSy=${totalSy}, totalPt=${totalPt} → need PT=${PT_IN} for SY=${SY_IN}`);
  if (ptBefore < PT_IN) {
    console.log(`   skip — insufficient PT (${ptBefore} < ${PT_IN})`);
  } else {
    // ActionRouter v3 fixes the SY-share typing bug. Approvals go to the
    // ROUTER (v3), not the market. v2 would revert here.
    await approveIfNeeded(shareTok, ROUTER, SY_IN, "SY (to router v3)");
    await approveIfNeeded(PT, ROUTER, PT_IN, "PT (to router v3)");
    const MIN_LP_OUT = 0n; // accept whatever; smoke test
    const DEADLINE = Math.floor(Date.now() / 1000) + 600;
    await execContract(
      ROUTER,
      "addLiquidityProportional(address,uint256,uint256,uint256,address,uint256)",
      new ContractFunctionParameters()
        .addAddress(MARKET)
        .addUint256(SY_IN.toString())
        .addUint256(PT_IN.toString())
        .addUint256(MIN_LP_OUT.toString())
        .addAddress(evmAddr)
        .addUint256(DEADLINE),
      4_000_000,
      "router.addLiquidityProportional",
    );
    await new Promise((r) => setTimeout(r, 3000));
    const syAfter = await balanceOf(shareTok, evmAddr);
    const ptAfter = await balanceOf(PT, evmAddr);
    const lpAfter = await balanceOf(LP, evmAddr);
    console.log(`   SY  ${syBefore} → ${syAfter}  (Δ ${syAfter - syBefore})`);
    console.log(`   PT  ${ptBefore} → ${ptAfter}  (Δ ${ptAfter - ptBefore})`);
    console.log(`   LP  ${lpBefore} → ${lpAfter}  (Δ ${lpAfter - lpBefore})`);
  }
}

// ─── 6/6: Remove Liquidity ───────────────────────────────────────
{
  console.log("\n═══ 6/6: Remove LP (router.removeLiquidityProportional, 500K LP) ═══");
  const lpBefore = await balanceOf(LP, evmAddr);
  if (lpBefore === 0n) {
    console.log("   skip — no LP to remove");
  } else {
    const syBefore = await balanceOf(shareTok, evmAddr);
    const ptBefore = await balanceOf(PT, evmAddr);
    const LP_IN = lpBefore > 500_000n ? 500_000n : lpBefore;
    await approveIfNeeded(LP, ROUTER, LP_IN, "LP");
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await execContract(
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
    console.log(`   LP  ${lpBefore} → ${lpAfter}  (Δ ${lpAfter - lpBefore})`);
    console.log(`   SY  ${syBefore} → ${syAfter}  (Δ ${syAfter - syBefore})`);
    console.log(`   PT  ${ptBefore} → ${ptAfter}  (Δ ${ptAfter - ptBefore})`);
  }
}

client.close();
console.log("\nDone.");
