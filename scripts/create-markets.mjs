#!/usr/bin/env node
// After confirmSY: create both markets (standard + rewards) on the factory.
// The Market constructors call into the bytecode-isolation deployers, which
// each instantiate a fresh FissionMarket / FissionMarketRewards. After
// construction, the factory invokes `m.setTokens{value: msg.value}(…)` which
// creates 3 HTS tokens (PT, YT, LP) per market — needs ~3 HBAR per market.
//
// Usage:
//   FACTORY_ADDRESS=0x... \
//   SY_HBARX_ADDRESS=0x... \
//   SY_SAUCER_V2_LP_ADDRESS=0x... \
//   STD_EXPIRY=<unix>  RWD_EXPIRY=<unix>  \
//   STD_SCALAR_ROOT=75e18  RWD_SCALAR_ROOT=75e18 \
//   STD_SUFFIX="HBARX-2027-01-01"  RWD_SUFFIX="SS-V2-LP-2027-01-01" \
//   node scripts/create-markets.mjs

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

const factoryEvm = process.env.FACTORY_ADDRESS;
const syHbarx = process.env.SY_HBARX_ADDRESS;
const sySaucer = process.env.SY_SAUCER_V2_LP_ADDRESS;
const stdExpiry = BigInt(process.env.STD_EXPIRY ?? "0");
const rwdExpiry = BigInt(process.env.RWD_EXPIRY ?? "0");
const stdScalar = BigInt(process.env.STD_SCALAR_ROOT ?? "75000000000000000000");
const rwdScalar = BigInt(process.env.RWD_SCALAR_ROOT ?? "75000000000000000000");
const stdSuffix = process.env.STD_SUFFIX ?? "HBARX";
const rwdSuffix = process.env.RWD_SUFFIX ?? "SS-V2-LP";
if (!factoryEvm || !syHbarx || !sySaucer || stdExpiry === 0n || rwdExpiry === 0n) {
  console.error("Set FACTORY_ADDRESS, SY_HBARX_ADDRESS, SY_SAUCER_V2_LP_ADDRESS, STD_EXPIRY, RWD_EXPIRY.");
  process.exit(1);
}

const operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
const evmAddr = "0x" + operatorKey.publicKey.toEvmAddress();
let operatorIdStr = (process.env.HEDERA_OPERATOR_ID || "").trim();
if (!operatorIdStr || operatorIdStr === "0.0.XXXXXX") {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  operatorIdStr = (await r.json()).account;
}
const client = Client.forMainnet().setOperator(operatorIdStr, operatorKey);

const lookup = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${factoryEvm}`);
const factoryId = ContractId.fromString((await lookup.json()).contract_id);

async function callFactory(fn, args, name, payableHbar) {
  console.log(`\n→ factory.${fn}(${args.join(", ")}) with ${payableHbar} HBAR…`);
  // SDK addUint256/addInt256 want String|Number|BigNumber, not native bigint.
  const params = new ContractFunctionParameters()
    .addAddress(args[0])
    .addUint256(args[1].toString())
    .addInt256(args[2].toString())
    .addString(args[3]);
  const tx = new ContractExecuteTransaction()
    .setContractId(factoryId)
    .setGas(15_000_000)
    .setMaxTransactionFee(new Hbar(120))
    .setPayableAmount(new Hbar(payableHbar))
    .setFunction(fn, params);
  const submit = await tx.execute(client);
  const receipt = await submit.getReceipt(client);
  console.log(`  ${name}: ${receipt.status.toString()}`);
  if (receipt.status.toString() !== "SUCCESS") process.exit(1);
}

// 60 HBAR per market: 3 HTS createFungibleToken calls (PT, YT, LP) at
// ~15 HBAR each (token + 90d auto-renew prepay), plus margin.
await callFactory("createMarket",        [syHbarx,  stdExpiry, stdScalar, stdSuffix], "createMarket",        60);
await callFactory("createRewardsMarket", [sySaucer, rwdExpiry, rwdScalar, rwdSuffix], "createRewardsMarket", 60);

console.log(`\n✓ Both markets deployed. Read factory.markets() to see addresses, or check MarketCreated logs.`);
client.close();
