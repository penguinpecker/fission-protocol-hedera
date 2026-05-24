#!/usr/bin/env node
// Send a small HBAR balance to the FissionUnzap so it can auto-associate
// tokens on receipt. Per HIP-904, auto-assoc requires the receiver to
// have enough HBAR for the assoc fee (~0.05 HBAR per token). The unzap
// will briefly hold PT, SY-share, USDC, WHBAR — 4 tokens.

import { Client, Hbar, PrivateKey, TransferTransaction } from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() { const p = join(REPO, ".env"); if (!existsSync(p)) return; for (const l of readFileSync(p,"utf8").split("\n")) { const t=l.trim(); if(!t||t.startsWith("#"))continue; const e=t.indexOf("="); if(e<0)continue; const k=t.slice(0,e).trim(); let v=t.slice(e+1).trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1); if(!process.env[k])process.env[k]=v; } }
loadDotenv();
function deriveKey() { if (process.env.HEDERA_OPERATOR_KEY) return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/,""); const s=process.env.SEED_PHRASE; if(!validateMnemonic(s,wordlist))throw new Error("bad seed"); const c=HDKey.fromMasterSeed(mnemonicToSeedSync(s)).derive(process.env.HEDERA_DERIVATION_PATH||"m/44'/3030'/0'/0/0"); return Buffer.from(c.privateKey).toString("hex"); }

const opKey = PrivateKey.fromStringECDSA(deriveKey());
const opId  = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(opId, opKey);

const dep = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
const UNZAP_ID = dep.fission_unzap.id;

const FUND_AMOUNT = 5; // 5 HBAR — covers ~100 auto-associations + buffer

console.log(`Funding ${UNZAP_ID} with ${FUND_AMOUNT} HBAR for auto-assoc fees…`);
const tx = await new TransferTransaction()
  .addHbarTransfer(opId, new Hbar(-FUND_AMOUNT))
  .addHbarTransfer(UNZAP_ID, new Hbar(FUND_AMOUNT))
  .execute(client);
const rcpt = await tx.getReceipt(client);
console.log(`  status: ${rcpt.status.toString()}  tx=${tx.transactionId.toString()}`);

client.close();
