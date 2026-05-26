#!/usr/bin/env node
// Continue fund flow after zap succeeded on-chain. Skip zap, do split + addLiquidity.

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

const market = getAddress("0x556938AcfDa70dF2A32ea97e6B6862B874d93ef9");
const shareToken = getAddress("0x0000000000000000000000000000000000A02586");
const pt = getAddress("0x0000000000000000000000000000000000a0259F");

const marketAbi = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function send(label, req) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(req);
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const rec = await pub.waitForTransactionReceipt({ hash });
    if (rec.status !== "success") throw new Error(`status=${rec.status}`);
    console.log(`  ✓ ${hash}`);
  } catch (e) {
    // Hashio sometimes errors on receipt fetch; check mirror.
    const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
    if (r.ok) {
      const d = await r.json();
      if (d.result === "SUCCESS") console.log(`  ✓ ${hash} (via mirror)`);
      else throw new Error(`${label} ${d.result}: ${d.error_message}`);
    } else {
      throw e;
    }
  }
}

const syBal = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`SY balance: ${syBal}`);

const halfSy = syBal / 2n;
const remainingSy = syBal - halfSy;

await send("SY.approve(market)", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

await send(`Market.split(${halfSy})`, {
  account, address: market, abi: marketAbi, functionName: "split",
  args: [halfSy], gas: 4_000_000n, gasPrice: GAS,
});

const ptBal = await pub.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`PT balance after split: ${ptBal}`);

await send("PT.approve(market)", {
  account, address: pt, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

// Add proportional liquidity. The pool will use the lesser of (sy * ratio, pt * ratio)
// and refund the unused side. Either input fits since they came from a 50/50 split.
await send(`Market.addLiquidity(syIn=${remainingSy}, ptIn=${ptBal})`, {
  account, address: market, abi: marketAbi, functionName: "addLiquidity",
  args: [remainingSy, ptBal, 1n, account.address],
  gas: 6_000_000n, gasPrice: GAS,
});

const totalPt = await pub.readContract({ address: market, abi: marketAbi, functionName: "totalPt" });
const totalSy = await pub.readContract({ address: market, abi: marketAbi, functionName: "totalSy" });
console.log(`\n✅ Pool depth:`);
console.log(`   totalPt: ${totalPt}`);
console.log(`   totalSy: ${totalSy}`);
