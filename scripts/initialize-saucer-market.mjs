#!/usr/bin/env node
// End-to-end seed-liquidity for Market 1 (SaucerSwap V2 LP rewards).
// Pipeline:
//   0. Set operator's max_auto_associations = -1 (HIP-904 unlimited).
//   1. Wrap N HBAR → N WHBAR via WHBAR contract 0x163b59.
//   2. Swap M WHBAR → USDC via SaucerSwap V2 SwapRouter (exactInputSingle).
//   3. Approve both tokens to SY_SaucerSwapV2LP.
//   4. SY.depositLiquidity(amount0=USDC, amount1=WHBAR, ...) → mint shares.
//   5. Approve shareToken to market.
//   6. market.split(half-of-shares) → PT + YT.
//   7. Approve shareToken + PT to market.
//   8. market.initialize(syIn, ptIn, anchor, lnFeeRoot, reservePct).
//
// Configurable via env (sane defaults for a 100-HBAR seed):
//   HBAR_TO_WRAP=100              (total HBAR to commit)
//   HBAR_TO_SWAP_FOR_USDC=50      (half goes to USDC, half stays as WHBAR)
//   USDC_AMOUNT_OUT_MIN=4000000   (~$4.0 USDC; protects against bad slippage)
//   INITIAL_ANCHOR_E18=1020000000000000000  (1.02e18 = 2% implied yield)
//   LN_FEE_RATE_ROOT_E18=300000000000000    (3e14 = ~0.03% trade fee)
//   RESERVE_FEE_PERCENT=80

import {
  AccountId, AccountUpdateTransaction,
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

// ── known mainnet addresses ──
const WHBAR_CONTRACT = "0x0000000000000000000000000000000000163b59"; // wrap/unwrap
const WHBAR_TOKEN    = "0x0000000000000000000000000000000000163b5a"; // HTS facade
const USDC_TOKEN     = "0x000000000000000000000000000000000006f89a"; // HTS facade
const V2_SWAP_ROUTER = "0x00000000000000000000000000000000003c437a";
const POOL_FEE = 1500;

const MARKET_ADDRESS = process.env.MARKET_ADDRESS    || "0x98fe6ad01129b5a1c37891b60c5eff526184ec93";
const SY_ADDRESS     = process.env.SY_SAUCER_V2_LP_ADDRESS || "0xd4b535589148ea8bdf4ca64ee1007780d3d08c62";

const HBAR_TO_WRAP = Number(process.env.HBAR_TO_WRAP ?? "100");
const HBAR_TO_SWAP = Number(process.env.HBAR_TO_SWAP_FOR_USDC ?? "50");
const USDC_OUT_MIN = process.env.USDC_AMOUNT_OUT_MIN ?? "4000000"; // 6 dec
const INITIAL_ANCHOR = process.env.INITIAL_ANCHOR_E18 ?? "1020000000000000000";
const LN_FEE = process.env.LN_FEE_RATE_ROOT_E18 ?? "300000000000000";
const RESERVE = process.env.RESERVE_FEE_PERCENT ?? "80";

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

async function lookup(addr) {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${addr}`);
  const j = await r.json();
  if (!j.contract_id) throw new Error(`no contract at ${addr}`);
  return ContractId.fromString(j.contract_id);
}
async function tokenIdFromEvm(evm) {
  const num = parseInt(evm.replace(/^0x/, ""), 16);
  return `0.0.${num}`;
}

console.log(`Operator: ${operatorIdStr} / ${evmAddr}`);
console.log(`Market:   ${MARKET_ADDRESS}`);
console.log(`SY:       ${SY_ADDRESS}`);

// ── 0. Set HIP-904 unlimited auto-associations on operator ──
console.log(`\n[0] Set max_auto_associations = -1 (HIP-904 unlimited)…`);
{
  const tx = await new AccountUpdateTransaction()
    .setAccountId(AccountId.fromString(operatorIdStr))
    .setMaxAutomaticTokenAssociations(-1)
    .setMaxTransactionFee(new Hbar(2))
    .freezeWith(client)
    .sign(operatorKey);
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// ── 1. Wrap HBAR → WHBAR (skip if already have enough) ──
const SKIP_WRAP = process.env.SKIP_WRAP === "1";
const whbarContractId = await lookup(WHBAR_CONTRACT);
if (SKIP_WRAP) {
  console.log(`\n[1] SKIP_WRAP=1 — using existing WHBAR balance`);
} else {
  console.log(`\n[1] Wrap ${HBAR_TO_WRAP} HBAR → WHBAR via 0x163b59.deposit{value}…`);
  const tx = new ContractExecuteTransaction()
    .setContractId(whbarContractId)
    .setGas(300_000)
    .setMaxTransactionFee(new Hbar(2))
    .setPayableAmount(new Hbar(HBAR_TO_WRAP))
    .setFunction("deposit");
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// ── 2. Approve V2 router for WHBAR, then swap HBAR_TO_SWAP WHBAR → USDC ──
const WHBAR_TO_SWAP_RAW = BigInt(HBAR_TO_SWAP) * 10n**8n; // 8 dec
const SKIP_SWAP = process.env.SKIP_SWAP === "1";
const whbarTokenId = ContractId.fromEvmAddress(0, 0, WHBAR_TOKEN);
if (SKIP_SWAP) {
  console.log(`\n[2] SKIP_SWAP=1 — using existing USDC balance`);
} else {
console.log(`\n[2a] WHBAR.approve(router, ${WHBAR_TO_SWAP_RAW})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(whbarTokenId)
    .setGas(800_000) // HTS approve via ERC-20 facade is gas-heavy
    .setMaxTransactionFee(new Hbar(5))
    .setFunction(
      "approve",
      new ContractFunctionParameters().addAddress(V2_SWAP_ROUTER).addUint256(WHBAR_TO_SWAP_RAW.toString())
    );
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

console.log(`\n[2b] router.exactInputSingle(WHBAR→USDC, ${WHBAR_TO_SWAP_RAW} in, ≥${USDC_OUT_MIN} out)…`);
const routerId = await lookup(V2_SWAP_ROUTER);
const deadline = (Math.floor(Date.now() / 1000) + 600).toString();
{
  // ExactInputSingleParams tuple: (tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96)
  // SDK doesn't directly support tuples; use raw hex via setFunctionParameters.
  // Encode manually.
  const ABI_ENCODE = (types, values) => {
    // Minimal ABI encoder for our flat tuple — using ethers-style encoding via viem-light here would be cleaner
    // but to avoid extra deps, encode by hand for fixed-shape struct.
    // All 8 fields fit in 32 bytes each = 256 bytes total.
    const pad = (h, n=64) => h.replace(/^0x/, "").padStart(n, "0");
    return Buffer.from(
      values.map((v, i) => {
        if (types[i] === "address") return pad(v.toLowerCase().replace(/^0x/, ""));
        if (types[i] === "uint24" || types[i] === "uint256" || types[i] === "uint160") return pad(BigInt(v).toString(16));
        throw new Error("unsupported type");
      }).join(""),
      "hex"
    );
  };
  const tupleData = ABI_ENCODE(
    ["address","address","uint24","address","uint256","uint256","uint256","uint160"],
    [WHBAR_TOKEN, USDC_TOKEN, POOL_FEE, evmAddr, deadline, WHBAR_TO_SWAP_RAW.toString(), USDC_OUT_MIN, "0"]
  );
  // selector for exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
  // — the V3 SwapRouter01 form (with deadline). The 7-field SwapRouter02 form is
  // 0x04e45aaf; mismatching selector vs field count silently reverts.
  const selector = Buffer.from("414bf389", "hex");
  const fullCall = Buffer.concat([selector, tupleData]);

  const tx = new ContractExecuteTransaction()
    .setContractId(routerId)
    .setGas(2_000_000)
    .setMaxTransactionFee(new Hbar(15))
    .setFunctionParameters(fullCall);
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
} // end if (!SKIP_SWAP)

// Read balances. Use Mirror Node (always fresh) — Hashio's eth_call caches
// HTS balances within a block boundary, returning 0 right after a swap that
// did successfully credit the wallet.
async function balanceOf(tokenAddr) {
  const tokenId = `0.0.${parseInt(tokenAddr.replace(/^0x/, ""), 16)}`;
  const r = await fetch(
    `https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}/tokens?token.id=${tokenId}`
  ).then(r => r.json());
  const t = (r.tokens || []).find(x => x.token_id === tokenId);
  return BigInt(t?.balance ?? 0);
}

const usdcBal = await balanceOf(USDC_TOKEN);
const whbarBal = await balanceOf(WHBAR_TOKEN);
console.log(`\n   Operator now holds: ${usdcBal} USDC raw (${Number(usdcBal)/1e6} USDC), ${whbarBal} WHBAR raw (${Number(whbarBal)/1e8} WHBAR)`);
if (usdcBal === 0n) throw new Error("USDC balance still 0 after swap — abort.");

// ── 3. Approve SY for both tokens ──
const SYM_DESIRED_USDC = usdcBal;
const SYM_DESIRED_WHBAR = whbarBal;
console.log(`\n[3a] USDC.approve(SY, ${SYM_DESIRED_USDC})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, USDC_TOKEN))
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(SY_ADDRESS).addUint256(SYM_DESIRED_USDC.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
console.log(`[3b] WHBAR.approve(SY, ${SYM_DESIRED_WHBAR})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(whbarTokenId)
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(SY_ADDRESS).addUint256(SYM_DESIRED_WHBAR.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// ── 4. SY.depositLiquidity ──
console.log(`\n[4] SY.depositLiquidity(${SYM_DESIRED_USDC}, ${SYM_DESIRED_WHBAR}, 0, 0, operator, 1)…`);
const syId = await lookup(SY_ADDRESS);
{
  // Forward 5 HBAR to cover SaucerSwap V2 NPM's mint fee (USD-cents-denominated,
  // converted to HBAR via tinycentsToTinybars; NPM checks SELFBALANCE >= fee).
  // Gas: V3 mint + 4 HTS precompile calls (transferFrom×2, refund×2) is ~8M.
  const tx = new ContractExecuteTransaction()
    .setContractId(syId)
    .setGas(15_000_000)
    .setMaxTransactionFee(new Hbar(40))
    .setPayableAmount(new Hbar(5))
    .setFunction(
      "depositLiquidity",
      new ContractFunctionParameters()
        .addUint256(SYM_DESIRED_USDC.toString())
        .addUint256(SYM_DESIRED_WHBAR.toString())
        .addUint256("0") // amount0Min — TODO tighten in production
        .addUint256("0")
        .addAddress(evmAddr)
        .addUint128("1") // minLiquidity
    );
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// Read share balance.
const shareTokenRes = await fetch("https://mainnet.hashio.io/api", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SY_ADDRESS, data: "0x6c9fa59e" /* shareToken() */ }, "latest"] }),
}).then(r => r.json());
const shareToken = "0x" + shareTokenRes.result.slice(26);
const shareBal = await balanceOf(shareToken);
console.log(`\n   SY shares minted: ${shareBal}`);
if (shareBal < 1000n) throw new Error("Too few SY shares to split — increase HBAR_TO_WRAP.");

// ── 5. Split half of shares ──
const SY_TO_SPLIT = shareBal / 2n;
const SY_REMAIN = shareBal - SY_TO_SPLIT;
console.log(`\n[5a] shareToken.approve(market, ${SY_TO_SPLIT})…`);
const marketId = await lookup(MARKET_ADDRESS);
const shareTokenId = ContractId.fromEvmAddress(0, 0, shareToken);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(shareTokenId)
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET_ADDRESS).addUint256(SY_TO_SPLIT.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
console.log(`[5b] market.split(${SY_TO_SPLIT})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(marketId)
    .setGas(2_000_000)
    .setMaxTransactionFee(new Hbar(15))
    .setFunction("split", new ContractFunctionParameters().addUint256(SY_TO_SPLIT.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// ── 6. Initialize ──
const ptRes = await fetch("https://mainnet.hashio.io/api", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MARKET_ADDRESS, data: "0xdc263022" /* pt() */ }, "latest"] }),
}).then(r => r.json());
const pt = "0x" + ptRes.result.slice(26);

const SY_IN = SY_REMAIN;
const PT_IN = SY_TO_SPLIT; // PT minted from split == SY_TO_SPLIT 1:1

console.log(`\n[6a] shareToken.approve(market, ${SY_IN}) for initialize…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(shareTokenId)
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET_ADDRESS).addUint256(SY_IN.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
console.log(`[6b] PT.approve(market, ${PT_IN})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, pt))
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET_ADDRESS).addUint256(PT_IN.toString()));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}
console.log(`[6c] market.initialize(syIn=${SY_IN}, ptIn=${PT_IN}, anchor=${INITIAL_ANCHOR}, lnFee=${LN_FEE}, reserve=${RESERVE})…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(marketId)
    .setGas(3_000_000)
    .setMaxTransactionFee(new Hbar(20))
    .setFunction(
      "initialize",
      new ContractFunctionParameters()
        .addUint256(SY_IN.toString())
        .addUint256(PT_IN.toString())
        .addInt256(INITIAL_ANCHOR)
        .addInt256(LN_FEE)
        .addUint256(RESERVE)
    );
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

console.log(`\n✓ Market 1 initialized.`);
console.log(`   pt: ${pt}`);
console.log(`   shareToken: ${shareToken}`);
client.close();
