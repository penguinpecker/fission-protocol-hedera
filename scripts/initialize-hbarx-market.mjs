#!/usr/bin/env node
// Seed-liquidity initializer for Market 0 (SY_HBARX standard).
// Pipeline: HBARX in operator wallet → SY_HBARX.deposit → market.split →
// market.initialize. Caller must hold ADMIN_ROLE on the market (set to
// `marketAdmin` at factory.createMarket time — operator EOA in v1).
//
// Prerequisites the operator must hold BEFORE running:
//   • HBARX (HTS token 0.0.834116 / 0x...0cba44). Stake HBAR via Stader
//     (https://stader.staderlabs.com/hedera) to mint HBARX.
//   • The HBARX HTS token must be auto-associated to the operator wallet.
//   • Operator must hold the SY's shareToken HTS — auto-associated on first
//     deposit if HIP-904 unlimited associations are set on the wallet.
//
// Required env:
//   MARKET_ADDRESS=0x5d75cb89e26b6e009db583afbd3797ff8ad7c8ae
//   SY_HBARX_ADDRESS=0x80728fbad79974e428c50dc548853ff858d9430c
//   HBARX_ADDRESS=0x00000000000000000000000000000000000cba44
//   HBARX_TO_DEPOSIT=<8-decimals HBARX, e.g. "1000000000" = 10 HBARX>
//   SY_TO_SPLIT=<8-decimals shares, e.g. "500000000" = 5 SY shares>
//   SY_IN=<8-decimals SY for initialize, half of "remaining">
//   PT_IN=<8-decimals PT for initialize, equal to SY_IN for neutral>
//   INITIAL_ANCHOR_E18=<e.g. "1050000000000000000" = 1.05e18>
//   LN_FEE_RATE_ROOT_E18=<e.g. "300000000000000" = 3e14>
//   RESERVE_FEE_PERCENT=<0..100, e.g. "80">
//
// Recommended for HBARX-90D market:
//   INITIAL_ANCHOR_E18=1050000000000000000
//   LN_FEE_RATE_ROOT_E18=300000000000000
//   RESERVE_FEE_PERCENT=80

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

const env = (k, dflt) => {
  const v = process.env[k];
  if (v == null && dflt == null) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
  return v ?? dflt;
};

const MARKET = env("MARKET_ADDRESS");
const SY = env("SY_HBARX_ADDRESS");
const HBARX = env("HBARX_ADDRESS", "0x00000000000000000000000000000000000cba44");
const HBARX_TO_DEPOSIT = env("HBARX_TO_DEPOSIT");
const SY_TO_SPLIT = env("SY_TO_SPLIT");
const SY_IN = env("SY_IN");
const PT_IN = env("PT_IN");
const INITIAL_ANCHOR = env("INITIAL_ANCHOR_E18", "1050000000000000000");
const LN_FEE = env("LN_FEE_RATE_ROOT_E18", "300000000000000");
const RESERVE = env("RESERVE_FEE_PERCENT", "80");

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
  if (!j.contract_id) throw new Error(`no contract found at ${addr}`);
  return ContractId.fromString(j.contract_id);
}

const marketId = await lookup(MARKET);
const syId = await lookup(SY);
console.log(`Market: ${MARKET} → ${marketId.toString()}`);
console.log(`SY:     ${SY} → ${syId.toString()}`);

// Step 1: approve SY to spend operator's HBARX. ERC-20 facade `approve(spender, amount)`.
console.log(`\n[1/4] HBARX.approve(SY, ${HBARX_TO_DEPOSIT})…`);
const hbarxId = ContractId.fromEvmAddress(0, 0, HBARX);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(hbarxId)
    .setGas(200_000)
    .setMaxTransactionFee(new Hbar(2))
    .setFunction("approve", new ContractFunctionParameters().addAddress(SY).addUint256(HBARX_TO_DEPOSIT));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// Step 2: SY.deposit(receiver, tokenIn=HBARX, amountIn, minSharesOut=0).
console.log(`\n[2/4] SY.deposit(receiver=operator, HBARX, ${HBARX_TO_DEPOSIT}, minSharesOut=0)…`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(syId)
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction(
      "deposit",
      new ContractFunctionParameters()
        .addAddress(evmAddr)
        .addAddress(HBARX)
        .addUint256(HBARX_TO_DEPOSIT)
        .addUint256("0")
    );
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   ${r.status.toString()}`);
}

// Step 3: market.split(amount) — splits SY shares into PT + YT, both go to caller.
console.log(`\n[3/4] market.split(${SY_TO_SPLIT})…`);
// Need SY shares approved for the market first.
const syShareToken = SY; // SY contract IS the share token? Actually share token is sy.shareToken().
// Read shareToken first.
const shareTokenRes = await fetch("https://mainnet.hashio.io/api", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SY, data: "0xc0d78655" /* shareToken() */ }, "latest"] }),
}).then(r => r.json());
const shareToken = "0x" + shareTokenRes.result.slice(26);
console.log(`   shareToken = ${shareToken}`);
{
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, shareToken))
    .setGas(200_000)
    .setMaxTransactionFee(new Hbar(2))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET).addUint256(SY_TO_SPLIT));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   shareToken.approve(market): ${r.status.toString()}`);
}
{
  const tx = new ContractExecuteTransaction()
    .setContractId(marketId)
    .setGas(800_000)
    .setMaxTransactionFee(new Hbar(5))
    .setFunction("split", new ContractFunctionParameters().addUint256(SY_TO_SPLIT));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   split: ${r.status.toString()}`);
}

// Step 4: approve PT, then market.initialize.
console.log(`\n[4/4] market.initialize(syIn=${SY_IN}, ptIn=${PT_IN}, anchor=${INITIAL_ANCHOR}, lnFee=${LN_FEE}, reserve=${RESERVE})…`);
const ptRes = await fetch("https://mainnet.hashio.io/api", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MARKET, data: "0xdc263022" /* pt() */ }, "latest"] }),
}).then(r => r.json());
const pt = "0x" + ptRes.result.slice(26);
console.log(`   pt = ${pt}`);

// Approve shareToken (extra) and PT to the market for initialize.
{
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, shareToken))
    .setGas(200_000)
    .setMaxTransactionFee(new Hbar(2))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET).addUint256(SY_IN));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   shareToken.approve(market, syIn): ${r.status.toString()}`);
}
{
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, pt))
    .setGas(200_000)
    .setMaxTransactionFee(new Hbar(2))
    .setFunction("approve", new ContractFunctionParameters().addAddress(MARKET).addUint256(PT_IN));
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   pt.approve(market, ptIn): ${r.status.toString()}`);
}
{
  const tx = new ContractExecuteTransaction()
    .setContractId(marketId)
    .setGas(2_000_000)
    .setMaxTransactionFee(new Hbar(15))
    .setFunction(
      "initialize",
      new ContractFunctionParameters()
        .addUint256(SY_IN)
        .addUint256(PT_IN)
        .addInt256(INITIAL_ANCHOR)
        .addInt256(LN_FEE)
        .addUint256(RESERVE)
    );
  const r = await (await tx.execute(client)).getReceipt(client);
  console.log(`   initialize: ${r.status.toString()}`);
}

console.log(`\n✓ Market 0 initialized. Read market.totalLpSupply(), market.totalSyShares() to verify.`);
client.close();
