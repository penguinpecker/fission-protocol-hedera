// Send 1 tinyUSDC + 1 tinyWHBAR to the unzap to trigger auto-association.
import { Client, PrivateKey, TransferTransaction, TokenId, AccountId, Hbar } from "@hashgraph/sdk";
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
const opId  = process.env.HEDERA_OPERATOR_ID || "0.0.10463169";
const client = Client.forMainnet().setOperator(opId, opKey);

const UNZAP_ID = "0.0.10492480";
const USDC = "0.0.456858";
const WHBAR = "0.0.1456986";

console.log(`Sending dust to ${UNZAP_ID} to trigger auto-assoc of USDC + WHBAR…`);
const tx = await new TransferTransaction()
  .addTokenTransfer(TokenId.fromString(USDC), AccountId.fromString(opId), -1)
  .addTokenTransfer(TokenId.fromString(USDC), AccountId.fromString(UNZAP_ID), 1)
  .addTokenTransfer(TokenId.fromString(WHBAR), AccountId.fromString(opId), -1)
  .addTokenTransfer(TokenId.fromString(WHBAR), AccountId.fromString(UNZAP_ID), 1)
  .setMaxTransactionFee(new Hbar(5))
  .execute(client);
const r = await tx.getReceipt(client);
console.log(`  status: ${r.status.toString()}`);
client.close();
