#!/usr/bin/env node
import { createPublicClient, createWalletClient, http, getAddress } from "viem";
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

const PK = ("0x" + process.env.NEW_DEPLOYER_KEY.replace(/^0x/, "")).trim();
const account = privateKeyToAccount(PK);
const chain = { id: 295, name: "Hedera", nativeCurrency: { decimals: 18, symbol: "HBAR", name: "HBAR" }, rpcUrls: { default: { http: ["https://mainnet.hashio.io/api"] } } };
const pub = createPublicClient({ chain, transport: http() });
const wlt = createWalletClient({ account, chain, transport: http() });

const periphery = getAddress(process.argv[2] || "0x8ce95cef2c521df83f346b579de84fa4aa8f50aa");
const market = getAddress(process.argv[3] || "0x3aCDD09b5850F551D9F2b4FE949439c2499f86C1");
const abi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8")).abi;

console.log(`Periphery: ${periphery}`);
console.log(`Market:    ${market}`);
const hash = await wlt.writeContract({
  account, address: periphery, abi, functionName: "registerMarket", args: [market],
  gas: 10_000_000n, gasPrice: 1_100_000_000_000n,
});
console.log(`tx: ${hash}`);
const rec = await pub.waitForTransactionReceipt({ hash });
console.log(`status: ${rec.status}  gasUsed: ${rec.gasUsed.toString()}`);
if (rec.status !== "success") process.exit(1);

const out = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
out.contracts.saucerSwapLPYieldSource = "0x0000000000000000000000000000000000a02585";
out.market = { address: market, expiry: out.market?.expiry, scalarRoot: out.market?.scalarRoot, suffix: "USDC-WHBAR-2026-08-24" };
writeFileSync(join(REPO, "deployments/295.json"), JSON.stringify(out, null, 2) + "\n");
console.log("✅ registerMarket succeeded; deployments/295.json updated");
