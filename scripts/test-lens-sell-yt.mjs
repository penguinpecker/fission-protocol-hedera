#!/usr/bin/env node
// Validate the FissionLens-driven Sell YT path at 0.1% slippage on live mainnet.
// Buys a small YT slice, calls lens.previewSwapExactYtForSy for the exact
// expected output, sets minSyOut = preview * 0.999, sells. Should land.

import { Client, ContractExecuteTransaction, ContractFunctionParameters, ContractId, Hbar, PrivateKey } from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv(){const p=join(REPO,".env");if(!existsSync(p))return;for(const l of readFileSync(p,"utf8").split("\n")){const t=l.trim();if(!t||t.startsWith("#"))continue;const e=t.indexOf("=");if(e<0)continue;const k=t.slice(0,e).trim();let v=t.slice(e+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!process.env[k])process.env[k]=v;}}
loadDotenv();
function deriveKey(){if(process.env.HEDERA_OPERATOR_KEY)return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/,"");const s=process.env.SEED_PHRASE;if(!validateMnemonic(s,wordlist))throw new Error("bad seed");const c=HDKey.fromMasterSeed(mnemonicToSeedSync(s)).derive(process.env.HEDERA_DERIVATION_PATH||"m/44'/3030'/0'/0/0");return Buffer.from(c.privateKey).toString("hex");}

const opKey = PrivateKey.fromStringECDSA(deriveKey());
const opEvm = ("0x" + opKey.publicKey.toEvmAddress()).toLowerCase();
const opId  = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(opId, opKey);
client.setDefaultMaxTransactionFee(new Hbar(20));

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const RPC    = "https://mainnet.hashio.io/api";
const LENS   = "0x0000000000000000000000000000000000a00fde";
const MARKET = "0x36ed8f34c9bfc0004f107153b1a16099f8910b58";
const MARKET_ID = "0.0.10488661";
const ROUTER_ID = "0.0.10475923";
const ROUTER_EVM= "0x00000000000000000000000000000000009fd993";
const SY_ID = "0.0.10465419";
const YT_AMOUNT = 200_000n;

async function bal(t,a){const r=await fetch(`${MIRROR}/api/v1/accounts/${a}/tokens?token.id=${t}`).then(x=>x.json());const e=(r.tokens||[]).find(x=>x.token_id===t);return e?BigInt(e.balance):0n;}
async function rpc(to,data){const r=await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to,data},"latest"]})}).then(x=>x.json());if(r.error)throw new Error(r.error.message);return r.result;}
async function ytBalanceOf(who){return BigInt(await rpc(MARKET,"0x2273bcc6"+who.replace(/^0x/,"").padStart(64,"0")));}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

console.log("="*70);
console.log("LENS-DRIVEN 0.1% SLIPPAGE SELL YT TEST");
console.log("="*70);

// Step 1: ensure operator has SY + buy YT
const opSy = await bal(SY_ID, opId);
console.log(`Operator SY: ${opSy}`);
if (opSy < 250_000n) { console.log("Insufficient SY"); client.close(); process.exit(1); }

console.log(`\nStep 1: Buy ${YT_AMOUNT} YT via router.buyYT (250k SY budget)`);
const a = await new ContractExecuteTransaction().setContractId(ContractId.fromString(SY_ID)).setGas(800_000).setFunction("approve", new ContractFunctionParameters().addAddress(ROUTER_EVM.slice(2)).addUint256("250000")).execute(client);
await a.getReceipt(client);
await sleep(4000);
const dl=Math.floor(Date.now()/1000)+600;
const b = await new ContractExecuteTransaction().setContractId(ContractId.fromString(ROUTER_ID)).setGas(6_000_000).setMaxTransactionFee(new Hbar(30)).setFunction("buyYT", new ContractFunctionParameters().addAddress(MARKET.slice(2)).addUint256("250000").addUint256("1").addAddress(opEvm.slice(2)).addUint256(dl.toString())).execute(client);
const br = await b.getReceipt(client);
console.log(`  buyYT: ${br.status.toString()}  tx=${b.transactionId.toString()}`);
await sleep(8000);

const ytBal = await ytBalanceOf(opEvm);
console.log(`  ytBalanceOf(op): ${ytBal}`);
if (ytBal < YT_AMOUNT) { console.log("Got less YT than expected"); client.close(); process.exit(1); }

// Step 2: lens preview
console.log(`\nStep 2: lens.previewSwapExactYtForSy(market, ${YT_AMOUNT})`);
const lensData = "0x5f0d5081" + MARKET.slice(2).padStart(64,"0") + YT_AMOUNT.toString(16).padStart(64,"0");
const previewRes = await rpc(LENS, lensData);
const syOut = BigInt("0x"+previewRes.slice(2,66));
const syOwed = BigInt("0x"+previewRes.slice(66,130));
console.log(`  lens.syOut:   ${syOut} (rate ${Number(syOut)/Number(YT_AMOUNT)})`);
console.log(`  lens.syOwed:  ${syOwed}`);

// Step 3: sell at 0.1% slippage from lens
const minSyOut = syOut * 999n / 1000n;
console.log(`\nStep 3: market.swapExactYtForSy(${YT_AMOUNT}, ${minSyOut}, op) — 0.1% slippage`);
const opSyBefore = await bal(SY_ID, opId);
const s = await new ContractExecuteTransaction().setContractId(ContractId.fromString(MARKET_ID)).setGas(4_500_000).setMaxTransactionFee(new Hbar(30)).setFunction("swapExactYtForSy", new ContractFunctionParameters().addUint256(YT_AMOUNT.toString()).addUint256(minSyOut.toString()).addAddress(opEvm.slice(2))).execute(client);
const sr = await s.getReceipt(client);
console.log(`  status: ${sr.status.toString()}`);
console.log(`  tx:     ${s.transactionId.toString()}`);
await sleep(8000);
const opSyAfter = await bal(SY_ID, opId);
const got = opSyAfter - opSyBefore;
console.log(`\n  Operator SY change: +${got}`);
console.log(`  Lens predicted:     +${syOut}`);
console.log(`  Diff:               ${got - syOut} (${((Number(got)-Number(syOut))/Number(syOut)*100).toFixed(4)}%)`);

if (sr.status.toString() === "SUCCESS") {
  console.log("\n✅ PASS — Lens-driven Sell YT at 0.1% slippage works end-to-end");
} else {
  console.log("\n❌ FAIL");
}
client.close();
