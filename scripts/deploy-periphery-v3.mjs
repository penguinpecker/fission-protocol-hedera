#!/usr/bin/env node
// Redeploy FissionPeriphery (v3) with audit pass-2 fixes:
//   X-3 per-side _checkSize (use totalSy() not totalPt+totalSy for SY-input)
//   X-4 remove quoteUnzapSy + _redeemSyToHbarExternal
//   X-5 isProtectedToken mapping; rescueToken rejects protocol tokens
//   X-6 v3NpmFeeBudget cap raised from 50 to 100 HBAR
//   X-8 delete dead deadline check in unzapSyToHbar
//   X-9 buySyForLp snapshots PT balance before swap, only consumes delta
//
// Uses Hedera SDK: maxAutoAssoc=-1, admin key (mutable), pre-registered market.

import { Client, ContractCreateFlow, ContractFunctionParameters, Hbar, PrivateKey } from "@hashgraph/sdk";
import { createPublicClient, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
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
const evmAddr = "0x" + opKey.publicKey.toEvmAddress();
let opIdStr = (process.env.NEW_DEPLOYER_ID || "").trim();
if (!opIdStr) {
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${evmAddr}`);
  opIdStr = (await r.json()).account;
}
const sdkClient = Client.forMainnet().setOperator(opIdStr, opKey);
sdkClient.setDefaultMaxTransactionFee(new Hbar(50));
sdkClient.setDefaultMaxQueryPayment(new Hbar(5));

const PK = "0x" + keyHex;
const account = privateKeyToAccount(PK);
const RPC = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
const chain = { id: 295, name: "Hedera", nativeCurrency: { decimals: 18, symbol: "HBAR", name: "HBAR" }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http() });

const NPM     = "00000000000000000000000000000000003ddbb9";
const USDC    = "000000000000000000000000000000000006f89a";
const WHBAR   = "0000000000000000000000000000000000163b5a";
const WHBAR_C = "0000000000000000000000000000000000163b59";
const V2R     = "00000000000000000000000000000000003c437a";
const MARKET  = "556938acfda70df2a32ea97e6b6862b874d93ef9";

const art = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8"));

console.log(`Operator: ${opIdStr} (${evmAddr})`);
console.log(`Balance:  ${(Number(await pub.getBalance({ address: account.address })) / 1e18).toFixed(2)} HBAR\n`);

console.log("→ Deploying FissionPeriphery v3 (audit pass-2 fixes)…");
const params = new ContractFunctionParameters()
  .addAddress(WHBAR_C).addAddress(WHBAR).addAddress(USDC)
  .addAddress(V2R).addAddress(NPM)
  .addAddressArray([MARKET]);

const tx = new ContractCreateFlow()
  .setBytecode(art.bytecode.object.replace(/^0x/, ""))
  .setGas(14_000_000)
  .setMaxAutomaticTokenAssociations(-1)
  .setConstructorParameters(params)
  .setAdminKey(opKey.publicKey);
const res = await tx.execute(sdkClient);
const rec = await res.getReceipt(sdkClient);
const cid = rec.contractId;
const periphery = "0x" + cid.toSolidityAddress();
console.log(`  ✓ Periphery v3 @ ${periphery} (${cid.toString()})\n`);

// Persist
const out = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
out.previousPeriphery2 = out.contracts.periphery;
out.contracts.periphery = getAddress(periphery);
out.peripheryV3Audit = {
  ts: new Date().toISOString(),
  fixes: ["X-3 per-side _checkSize", "X-4 remove quoteUnzapSy", "X-5 protectedToken rescue gate",
          "X-6 v3NpmFeeBudget cap 100 HBAR", "X-8 delete dead deadline check", "X-9 buySyForLp delta-only"],
  previousPeriphery: out.previousPeriphery2,
};
writeFileSync(join(REPO, "deployments/295.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  ✅ Periphery v3 live`);
console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  Periphery v3: ${periphery}`);
console.log(`  Periphery v2 (abandoned): ${out.previousPeriphery2}`);
console.log(`\n  NEXT: update Vercel env, indexer config, run setOperator + smoke`);

sdkClient.close();
