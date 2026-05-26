#!/usr/bin/env node
// Set the deployer EOA's max_automatic_token_associations to -1 so it
// auto-associates with new HTS tokens (PT/YT/LP/SY-share for the new market).

import { Client, AccountUpdateTransaction, AccountId, PrivateKey, Hbar } from "@hashgraph/sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
for (const l of readFileSync(join(REPO, ".env"), "utf8").split("\n")) {
  const e = l.indexOf("="); if (e < 0) continue;
  const k = l.slice(0, e).trim(); let v = l.slice(e + 1).trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const keyHex = (process.env.NEW_DEPLOYER_KEY || "").replace(/^0x/, "").trim();
const opKey = PrivateKey.fromStringECDSA(keyHex);
const opId = (process.env.NEW_DEPLOYER_ID || "").trim();
const client = Client.forMainnet().setOperator(opId, opKey);
client.setDefaultMaxTransactionFee(new Hbar(5));

const tx = new AccountUpdateTransaction()
  .setAccountId(AccountId.fromString(opId))
  .setMaxAutomaticTokenAssociations(-1);
const res = await tx.execute(client);
const rec = await res.getReceipt(client);
console.log("status:", rec.status.toString());

const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${opId}`);
const d = await r.json();
console.log(`${opId} max_auto_assoc:`, d.max_automatic_token_associations);

client.close();
