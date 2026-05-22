#!/usr/bin/env node
// Live test of the Sell YT flow. Operator buys a small YT slice then tries
// to sell it back via market.swapExactYtForSy directly. This reproduces
// what cosigner B should be able to do.

import { Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId, Hbar, PrivateKey } from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv(){ const p=join(REPO,".env"); if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const e=t.indexOf("=");if(e<0)continue;const k=t.slice(0,e).trim();let v=t.slice(e+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}}
loadDotenv();
function deriveKey(){if(process.env.HEDERA_OPERATOR_KEY)return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/,"");const s=process.env.SEED_PHRASE;if(!validateMnemonic(s,wordlist))throw new Error("bad seed");const c=HDKey.fromMasterSeed(mnemonicToSeedSync(s)).derive(process.env.HEDERA_DERIVATION_PATH||"m/44'/3030'/0'/0/0");return Buffer.from(c.privateKey).toString("hex");}

const opKey = PrivateKey.fromStringECDSA(deriveKey());
const opEvm = ("0x" + opKey.publicKey.toEvmAddress()).toLowerCase();
const opId  = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(opId, opKey);
client.setDefaultMaxTransactionFee(new Hbar(20));

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const RPC    = "https://mainnet.hashio.io/api";
const MARKET = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";
const MARKET_ID = "0.0.10488661";
const ROUTER = "0x00000000000000000000000000000000009fdf89";
const ROUTER_ID = "0.0.10477449";
const SY = "0x00000000000000000000000000000000009fb089";
const SY_SHARE_ID = "0.0.10465419";
const PT_ID = "0.0.10488662";
const YT_ID = "0.0.10488663";
const ZAP_ID = "0.0.10475908";

async function bal(t, a){const r=await fetch(`${MIRROR}/api/v1/accounts/${a}/tokens?token.id=${t}`).then(x=>x.json());const e=(r.tokens||[]).find(x=>x.token_id===t);return e?BigInt(e.balance):0n;}
async function rpc(to,data){const r=await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to,data},"latest"]})}).then(x=>x.json());if(r.error)throw new Error(r.error.message);return r.result;}
async function ytBalanceOf(who){const d="0x2273bcc6"+who.replace(/^0x/,"").padStart(64,"0");return BigInt(await rpc(MARKET,d));}
async function exec(cid,fn,p,gas,fee,pay){const tx=new ContractExecuteTransaction().setContractId(ContractId.fromString(cid)).setGas(gas).setMaxTransactionFee(new Hbar(fee)).setFunction(fn,p);if(pay)tx.setPayableAmount(new Hbar(pay));const s=await tx.execute(client);const r=await s.getReceipt(client);return {status:r.status.toString(),txId:s.transactionId.toString()};}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

console.log("=".repeat(70));
console.log(`Operator: ${opId} (${opEvm})`);
console.log(`Market:   ${MARKET_ID}`);
console.log("=".repeat(70));

// Step 1: operator's SY balance (might be 0 after sweep)
let opSy = await bal(SY_SHARE_ID, opId);
console.log(`\nOperator SY-share: ${opSy}  PT: ${await bal(PT_ID,opId)}  YT(ytBalanceOf): ${await ytBalanceOf(opEvm)}`);

if (opSy < 100_000n) {
  console.log("\nOperator has insufficient SY. Zapping 2 HBAR to get some...");
  await exec(ZAP_ID, "zapHbarToSy",
    new ContractFunctionParameters()
      .addAddress(SY.slice(2)).addUint256("0").addUint256("0").addUint256("0").addUint128("1").addAddress(opEvm.slice(2)),
    14_500_000, 50, 7
  );
  await sleep(8000);
  opSy = await bal(SY_SHARE_ID, opId);
  console.log(`After zap: SY = ${opSy}`);
}

// Step 2: BuyYT for a small amount
const SY_BUDGET = 500_000n;
console.log(`\n--- Step 1: Buy YT via router (syBudget=${SY_BUDGET}) ---`);
console.log("  approve SY → router");
const a1 = await exec(SY_SHARE_ID, "approve",
  new ContractFunctionParameters().addAddress(ROUTER.slice(2)).addUint256(SY_BUDGET.toString()),
  800_000, 5);
console.log(`    ${a1.status} ${a1.txId}`);
await sleep(4000);

console.log("  router.buyYT");
const deadline = Math.floor(Date.now()/1000)+600;
const b = await exec(ROUTER_ID, "buyYT",
  new ContractFunctionParameters()
    .addAddress(MARKET.slice(2))
    .addUint256(SY_BUDGET.toString())
    .addUint256("1")
    .addAddress(opEvm.slice(2))
    .addUint256(deadline.toString()),
  6_000_000, 30);
console.log(`    ${b.status} ${b.txId}`);
await sleep(8000);

const ytAfter = await ytBalanceOf(opEvm);
const opSyAfter1 = await bal(SY_SHARE_ID, opId);
console.log(`After buyYT: YT(ytBalanceOf) = ${ytAfter}  SY = ${opSyAfter1}  Δ_SY = ${opSyAfter1 - opSy}`);
if (ytAfter === 0n) { console.log("FAIL — operator got no YT, can't test sell"); process.exit(1); }

// Step 3: Sell YT direct on market
console.log(`\n--- Step 2: Sell YT direct on market (ytIn=${ytAfter}) ---`);
const s = await exec(MARKET_ID, "swapExactYtForSy",
  new ContractFunctionParameters()
    .addUint256(ytAfter.toString())
    .addUint256("1")
    .addAddress(opEvm.slice(2)),
  4_500_000, 30);
console.log(`    ${s.status} ${s.txId}`);
await sleep(8000);

const ytFinal = await ytBalanceOf(opEvm);
const opSyFinal = await bal(SY_SHARE_ID, opId);
console.log(`After sellYT: YT(ytBalanceOf) = ${ytFinal}  SY = ${opSyFinal}  Δ_SY = ${opSyFinal - opSyAfter1}`);

console.log("\n=== VERDICT ===");
if (s.status === "SUCCESS" && ytFinal === 0n) {
  console.log(`PASS — Sell YT works on chain. Got ${opSyFinal - opSyAfter1} SY for ${ytAfter} YT.`);
  console.log(`If cosigner B can't sell from the dApp, the issue is client-side, NOT the contract.`);
} else {
  console.log(`FAIL — status=${s.status} ytFinal=${ytFinal}`);
}
client.close();
