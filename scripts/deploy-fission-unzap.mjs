#!/usr/bin/env node
// Deploy FissionUnzap to Hedera mainnet via the operator key.
// Uses ContractCreateFlow (single-tx file+create flow) since the bytecode
// is small enough; mirrors deploy-lens.mjs pattern.

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

// Pinned mainnet addresses — must match the FissionZap deploy + Router v3.
const WHBAR_CONTRACT  = "0x0000000000000000000000000000000000163b59";
const WHBAR           = "0x0000000000000000000000000000000000163b5a";
const USDC            = "0x000000000000000000000000000000000006f89a";
const SAUCER_V2_ROUTER = "0x00000000000000000000000000000000003c437a";
const ROUTER_V3        = "0x00000000000000000000000000000000009fdf89";

// FileService stores bytecode as HEX-ENCODED TEXT (not raw bytes).
const art = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionUnzap.sol/FissionUnzap.json"), "utf8"));
let hex = art.bytecode.object;
if (hex.startsWith("0x")) hex = hex.slice(2);
const bytecodeBytes = new TextEncoder().encode(hex);
console.log(`Bytecode: ${hex.length / 2} bytes raw, ${bytecodeBytes.length}b hex-text`);

console.log("\nDeploying FissionUnzap via ContractCreateFlow…");
console.log("  Constructor args:");
console.log(`    WHBAR_CONTRACT    = ${WHBAR_CONTRACT}`);
console.log(`    WHBAR             = ${WHBAR}`);
console.log(`    USDC              = ${USDC}`);
console.log(`    SAUCER_V2_ROUTER  = ${SAUCER_V2_ROUTER}`);
console.log(`    ROUTER_V3         = ${ROUTER_V3}`);

const params = new ContractFunctionParameters()
  .addAddress(WHBAR_CONTRACT.slice(2))
  .addAddress(WHBAR.slice(2))
  .addAddress(USDC.slice(2))
  .addAddress(SAUCER_V2_ROUTER.slice(2))
  .addAddress(ROUTER_V3.slice(2));

const submit = await new ContractCreateFlow()
  .setBytecode(bytecodeBytes)
  .setConstructorParameters(params)
  .setGas(2_500_000)
  .setMaxAutomaticTokenAssociations(-1) // HIP-904 unlimited (will receive USDC/WHBAR mid-tx)
  .execute(client);

const receipt = await submit.getReceipt(client);
const contractId = receipt.contractId;
const num = contractId.num.toNumber();
const evm = "0x" + num.toString(16).padStart(40, "0");
console.log(`\n  ✓ Contract ID:  ${contractId.toString()}`);
console.log(`  ✓ EVM address:  ${evm}`);
console.log(`  ✓ Tx:           ${submit.transactionId.toString()}`);

// Persist into deployments JSON
const deploymentsPath = join(REPO, "deployments/295.json");
const dep = JSON.parse(readFileSync(deploymentsPath, "utf8"));
dep.fission_unzap = {
  id: contractId.toString(),
  evm,
  deployed_at: new Date().toISOString(),
  tx_id: submit.transactionId.toString(),
  constructor: {
    whbar_contract: WHBAR_CONTRACT,
    whbar: WHBAR,
    usdc: USDC,
    saucer_v2_router: SAUCER_V2_ROUTER,
    router_v3: ROUTER_V3,
  },
  notes: "One-tx PT/SY/LP → native HBAR. Mirror of FissionZap; uses sy.redeemLiquidity → V2 swap USDC→WHBAR → unwrap WHBAR.",
};
writeFileSync(deploymentsPath, JSON.stringify(dep, null, 2));
console.log(`\nSaved to deployments/295.json under .fission_unzap`);
client.close();
