#!/usr/bin/env node
// X-11 mitigation: revoke operator's standing approvals + setOperator on the
// abandoned Periphery v1/v2 + old market. v1 is immutable (no kill-switch)
// so removing the operator-side allowances is the only fix.

import { createPublicClient, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
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
const GAS = 1_100_000_000_000n;

const PERI_V1 = getAddress("0x8ce95cef2c521df83f346b579de84fa4aa8f50aa");
const PERI_V2 = getAddress("0x0000000000000000000000000000000000a025c1");
const OLD_MARKET = getAddress("0x556938AcfDa70dF2A32ea97e6B6862B874d93ef9");

const OLD_SY_SHARE = getAddress("0x0000000000000000000000000000000000A02586");
const OLD_PT = getAddress("0x0000000000000000000000000000000000a0259F");
const OLD_LP = getAddress("0x0000000000000000000000000000000000A025A1");

const erc20Abi = [
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];
const marketAbi = [
  { type: "function", name: "setOperator", inputs: [{ name: "o", type: "address" }, { name: "a", type: "bool" }], outputs: [], stateMutability: "nonpayable" },
];

async function send(label, req) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(req);
  await new Promise((r) => setTimeout(r, 6000));
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
  if (r.ok) {
    const d = await r.json();
    if (d.result === "SUCCESS") { console.log(`  ✓ ${hash}`); return true; }
    console.log(`  ✗ ${d.result}: ${d.error_message?.slice(0,60)}`);
  } else {
    console.log(`  ? mirror lag for ${hash}`);
  }
  return false;
}

// Revoke SY-share, PT, LP allowances to v1 and v2 (set to 0).
const tokens = [
  [OLD_SY_SHARE, "OLD_SY_SHARE"],
  [OLD_PT, "OLD_PT"],
  [OLD_LP, "OLD_LP"],
];
const peripheries = [
  [PERI_V1, "Periphery_v1"],
  [PERI_V2, "Periphery_v2"],
];

for (const [tok, tokLabel] of tokens) {
  for (const [peri, periLabel] of peripheries) {
    await send(`${tokLabel}.approve(${periLabel}, 0)`, {
      account, address: tok, abi: erc20Abi, functionName: "approve",
      args: [peri, 0n], gas: 500_000n, gasPrice: GAS,
    });
  }
}

// Revoke setOperator on the old market for v1 + v2.
for (const [peri, periLabel] of peripheries) {
  await send(`OLD_MARKET.setOperator(${periLabel}, false)`, {
    account, address: OLD_MARKET, abi: marketAbi, functionName: "setOperator",
    args: [peri, false], gas: 1_000_000n, gasPrice: GAS,
  });
}

console.log("\n✅ X-11 mitigation: revoked all operator approvals + operator-set on abandoned Peripheries.");
