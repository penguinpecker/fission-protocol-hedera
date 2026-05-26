#!/usr/bin/env node
// Redeploy FissionPeriphery with audit fixes (H-4 registered-adapter gate +
// buySyForLp ptOutFromSwap param). Same source file name; new on-chain instance.
// Uses Hedera SDK so we can set maxAutoAssoc=-1 + admin key (immutable contracts
// can't have those set post-deploy).

import {
  Client, ContractCreateFlow, ContractFunctionParameters, Hbar, PrivateKey,
} from "@hashgraph/sdk";
import {
  createPublicClient, createWalletClient, http, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
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
const wlt = createWalletClient({ account, chain, transport: http() });
const GAS = 1_100_000_000_000n;

const NPM_HEX     = "00000000000000000000000000000000003ddbb9";
const USDC_HEX    = "000000000000000000000000000000000006f89a";
const WHBAR_HEX   = "0000000000000000000000000000000000163b5a";
const WHBAR_C_HEX = "0000000000000000000000000000000000163b59";
const V2R_HEX     = "00000000000000000000000000000000003c437a";

// Reuse: market deployed in step5 redo.
const market = "556938acfda70df2a32ea97e6b6862b874d93ef9";

const art = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8"));

console.log(`Operator: ${opIdStr} (${evmAddr})`);
console.log(`Balance:  ${(Number(await pub.getBalance({ address: account.address })) / 1e18).toFixed(2)} HBAR\n`);

console.log("→ Deploying FissionPeriphery (with H-4 + buySyForLp fixes)…");
const params = new ContractFunctionParameters()
  .addAddress(WHBAR_C_HEX).addAddress(WHBAR_HEX).addAddress(USDC_HEX)
  .addAddress(V2R_HEX).addAddress(NPM_HEX)
  .addAddressArray([market]);

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
console.log(`  ✓ Periphery v2 @ ${periphery} (${cid.toString()})\n`);

// Persist
const out = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
out.previousPeriphery = out.contracts.periphery;
out.contracts.periphery = getAddress(periphery);
out.peripheryV2Audit = {
  ts: new Date().toISOString(),
  fixes: ["H-4: registeredSyAdapter gate on unzapSyToHbar", "buySyForLp: ptOutFromSwap param"],
  previousPeriphery: out.previousPeriphery,
};
writeFileSync(join(REPO, "deployments/295.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  ✅ Periphery v2 live`);
console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  Periphery v2: ${periphery}`);
console.log(`  Old Periphery: ${out.previousPeriphery} (abandoned)`);
console.log(`\n  NEXT: vercel env update NEXT_PUBLIC_PERIPHERY_ADDRESS=${periphery}`);

sdkClient.close();
