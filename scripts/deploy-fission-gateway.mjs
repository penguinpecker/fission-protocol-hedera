#!/usr/bin/env node
// Deploy FissionGateway to Hedera mainnet via the operator key.
// Replaces both FissionMegaZap + FissionUnzap with a unified periphery.
// Uses ContractCreateFlow for the single-tx file+create path.

import { Client, ContractCreateFlow, ContractFunctionParameters, Hbar, PrivateKey } from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
function loadDotenv() { const p = join(REPO, ".env"); if (!existsSync(p)) return; for (const l of readFileSync(p,"utf8").split("\n")) { const t=l.trim(); if(!t||t.startsWith("#"))continue; const e=t.indexOf("="); if(e<0)continue; const k=t.slice(0,e).trim(); let v=t.slice(e+1).trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1); if(!process.env[k])process.env[k]=v; } }
loadDotenv();
function deriveKey() { if (process.env.HEDERA_OPERATOR_KEY) return process.env.HEDERA_OPERATOR_KEY.replace(/^0x/,""); const s=process.env.SEED_PHRASE; if(!validateMnemonic(s,wordlist))throw new Error("bad seed"); const c=HDKey.fromMasterSeed(mnemonicToSeedSync(s)).derive(process.env.HEDERA_DERIVATION_PATH||"m/44'/3030'/0'/0/0"); return Buffer.from(c.privateKey).toString("hex"); }

const opKey = PrivateKey.fromStringECDSA(deriveKey());
const opId  = (process.env.HEDERA_OPERATOR_ID || "0.0.10463169").trim();
const client = Client.forMainnet().setOperator(opId, opKey);

// Pinned mainnet addresses.
const WHBAR_CONTRACT   = "0x0000000000000000000000000000000000163b59";
const WHBAR            = "0x0000000000000000000000000000000000163b5a";
const USDC             = "0x000000000000000000000000000000000006f89a";
const SAUCER_V2_ROUTER = "0x00000000000000000000000000000000003c437a";
const ROUTER_V3        = "0x00000000000000000000000000000000009fdf89";
const FISSION_ZAP      = "0x00000000000000000000000000000000009fd984";

const artifact = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionGateway.sol/FissionGateway.json"), "utf8"));
const bytecode = artifact.bytecode.object.replace(/^0x/, "");

console.log(`Deploying FissionGateway from ${opId} (bytecode ${bytecode.length/2} bytes)…`);

const params = new ContractFunctionParameters()
  .addAddress(WHBAR_CONTRACT)
  .addAddress(WHBAR)
  .addAddress(USDC)
  .addAddress(SAUCER_V2_ROUTER)
  .addAddress(ROUTER_V3)
  .addAddress(FISSION_ZAP);

const tx = new ContractCreateFlow()
  .setBytecode(bytecode)
  .setConstructorParameters(params)
  .setGas(6_500_000)  // 11kb runtime, modest constructor — 6.5M gas is generous
  .setAdminKey(opKey.publicKey)         // operator can rescue / transferOwnership
  .setMaxAutomaticTokenAssociations(-1); // HIP-904: auto-assoc any HTS token

console.log("Executing ContractCreateFlow…");
const resp = await tx.execute(client);
const rcpt = await resp.getReceipt(client);
const newId = rcpt.contractId.toString();
console.log(`  ✓ status: ${rcpt.status.toString()}`);
console.log(`  ✓ contract: ${newId}`);
console.log(`  ✓ HashScan: https://hashscan.io/mainnet/contract/${newId}`);

// EVM address = long-zero from entity id num
const num = Number(newId.split(".")[2]);
const evm = "0x" + num.toString(16).padStart(40, "0");
console.log(`  ✓ EVM addr: ${evm}`);

// Update deployments/295.json
const deployPath = join(REPO, "deployments/295.json");
const dep = JSON.parse(readFileSync(deployPath, "utf8"));
dep.fission_gateway = {
  id: newId,
  evm,
  deployed_at: new Date().toISOString(),
  constructor: {
    whbar_contract: WHBAR_CONTRACT,
    whbar: WHBAR,
    usdc: USDC,
    saucer_v2_router: SAUCER_V2_ROUTER,
    router_v3: ROUTER_V3,
    fission_zap: FISSION_ZAP,
  },
  notes: "v2 unified periphery — replaces FissionMegaZap + FissionUnzap. Atomic 1-tx for 6 of 7 user flows (Sell YT → HBAR is 2-tx forced by market wipe-on-msg.sender). Lazy int64.max approvals via _ensureApproval drop child-records ~5-9 per call.",
};
writeFileSync(deployPath, JSON.stringify(dep, null, 2) + "\n");
console.log(`  ✓ deployments/295.json updated`);

client.close();
