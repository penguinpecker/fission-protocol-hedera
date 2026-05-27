#!/usr/bin/env node
// X-2 fix: deploy a NEW SaucerSwapLPYieldSource with admin sweepHbar +
// receive(). Then propagate the cascade:
//   1. Deploy new SY (SDK, maxAutoAssoc=-1, admin key)
//   2. initShareToken (creates new fSY HTS token)
//   3. Factory.proposeSY(newSy) + confirmSY(newSy)
//   4. Factory.createRewardsMarket(newSy, expiry, scalar, suffix)
//   5. Periphery v3.registerMarket(newMarket)
//   6. newMarket.setOperator(peripheryV3, true)
//   7. Fund newMarket: zapHbarToSy(2000) → split → addLiquidity
//
// Old SY (0x...a02585) + old market (0x...3ef9) get archived in records.

import { Client, ContractCreateFlow, ContractExecuteTransaction, ContractFunctionParameters, Hbar, PrivateKey } from "@hashgraph/sdk";
import { createPublicClient, createWalletClient, http, parseEther, getAddress, decodeEventLog } from "viem";
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
const wlt = createWalletClient({ account, chain, transport: http() });
const GAS = 1_100_000_000_000n;

const NPM_HEX     = "00000000000000000000000000000000003ddbb9";
const USDC_HEX    = "000000000000000000000000000000000006f89a";
const WHBAR_HEX   = "0000000000000000000000000000000000163b5a";
const POOL_FEE   = 1500;
const TICK_LOWER = -887220;
const TICK_UPPER =  887220;

const T0 = USDC_HEX < WHBAR_HEX ? USDC_HEX : WHBAR_HEX;
const T1 = USDC_HEX < WHBAR_HEX ? WHBAR_HEX : USDC_HEX;

const factory = getAddress("0x799549F698bBBAc90B9e1C37eF3946A1A1d3397c");
const periphery = getAddress("0x0000000000000000000000000000000000a02731");

const artFactory = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionFactory.sol/FissionFactory.json"), "utf8"));
const artPeriphery = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionPeriphery.sol/FissionPeriphery.json"), "utf8"));
const artMarket = JSON.parse(readFileSync(join(REPO, "contracts/out/FissionRewardsMarket.sol/FissionRewardsMarket.json"), "utf8")).abi;
const artSY = JSON.parse(readFileSync(join(REPO, "contracts/out/SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json"), "utf8"));
const syAbi = artSY.abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

async function vsend(label, req) {
  console.log(`→ ${label}`);
  const hash = await wlt.writeContract(req);
  await new Promise((r) => setTimeout(r, 8000));
  const r = await fetch(`https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/results/${hash}`);
  if (!r.ok) throw new Error(`${label} mirror ${r.status}`);
  const d = await r.json();
  if (d.result !== "SUCCESS") throw new Error(`${label} ${d.result}: ${d.error_message}`);
  console.log(`  ✓ ${hash}`);
  return { hash, receipt: d };
}

console.log(`Operator: ${opIdStr} (${evmAddr})`);
console.log(`Balance:  ${(Number(await pub.getBalance({ address: account.address })) / 1e18).toFixed(2)} HBAR\n`);

// ── 1. Deploy new SY ──
console.log("→ Deploying SaucerSwapLPYieldSource (with sweepHbar) via SDK…");
const ctorParams = new ContractFunctionParameters()
  .addString("Fission SY SaucerSwap V2 USDC-WHBAR")
  .addString("fSY-USDC-WHBAR")
  .addAddress(T0).addAddress(T1)
  .addUint24(POOL_FEE).addInt24(TICK_LOWER).addInt24(TICK_UPPER)
  .addAddress(NPM_HEX)
  .addAddress(evmAddr.slice(2))
  .addUint32(0);
const syTx = new ContractCreateFlow()
  .setBytecode(artSY.bytecode.object.replace(/^0x/, ""))
  .setGas(12_000_000)
  .setMaxAutomaticTokenAssociations(-1)
  .setConstructorParameters(ctorParams)
  .setAdminKey(opKey.publicKey);
const syRes = await syTx.execute(sdkClient);
const syRec = await syRes.getReceipt(sdkClient);
const sy = "0x" + syRec.contractId.toSolidityAddress();
console.log(`  ✓ SY @ ${sy} (${syRec.contractId.toString()})\n`);

// ── 2. initShareToken via SDK (forwards HBAR for HTS createFungible) ──
console.log("→ SY.initShareToken via SDK (20 HBAR)…");
const initTx = await new ContractExecuteTransaction()
  .setContractId(syRec.contractId).setGas(4_000_000).setPayableAmount(new Hbar(20))
  .setFunction("initShareToken")
  .execute(sdkClient);
const initRec = await initTx.getReceipt(sdkClient);
console.log(`  ✓ ${initRec.status.toString()}\n`);

// ── 3. Factory.proposeSY + confirmSY ──
await vsend("Factory.proposeSY(newSy)", {
  account, address: factory, abi: artFactory.abi, functionName: "proposeSY", args: [getAddress(sy)],
  gas: 1_000_000n, gasPrice: GAS,
});
await vsend("Factory.confirmSY(newSy)", {
  account, address: factory, abi: artFactory.abi, functionName: "confirmSY", args: [getAddress(sy)],
  gas: 1_000_000n, gasPrice: GAS,
});

// ── 4. Factory.createRewardsMarket ──
const EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 86400 * 90);
const SCALAR = BigInt("5000000000000000000");
const SUFFIX = `USDC-WHBAR-${new Date(Number(EXPIRY) * 1000).toISOString().slice(0, 10)}-v3`;
const cmRec = await vsend(`Factory.createRewardsMarket (60 HBAR, ${SUFFIX})`, {
  account, address: factory, abi: artFactory.abi, functionName: "createRewardsMarket",
  args: [getAddress(sy), EXPIRY, SCALAR, SUFFIX],
  value: parseEther("60"), gas: 14_000_000n, gasPrice: GAS,
});

// Decode MarketCreated event
let market = null;
const txRec = await pub.getTransactionReceipt({ hash: cmRec.hash });
for (const log of txRec.logs) {
  try {
    const evt = decodeEventLog({ abi: artFactory.abi, data: log.data, topics: log.topics });
    if (evt.eventName === "MarketCreated") { market = evt.args.market; break; }
  } catch {}
}
if (!market) throw new Error("MarketCreated event missing");
console.log(`Market: ${market}\n`);

// ── 5. Periphery v3.registerMarket(newMarket) ──
await vsend("Periphery.registerMarket(newMarket)", {
  account, address: periphery, abi: artPeriphery.abi, functionName: "registerMarket",
  args: [market], gas: 10_000_000n, gasPrice: GAS,
});

// ── 6. setOperator(periphery_v3, true) on newMarket ──
await vsend("market.setOperator(periphery_v3, true)", {
  account, address: market, abi: artMarket, functionName: "setOperator",
  args: [periphery, true], gas: 1_000_000n, gasPrice: GAS,
});

// ── 7. Fund new market: zapHbarToSy(2000) → split → addLiquidity ──
const shareToken = await pub.readContract({ address: getAddress(sy), abi: syAbi, functionName: "shareToken" });
const pt = await pub.readContract({ address: market, abi: artMarket, functionName: "pt" });
console.log(`shareToken: ${shareToken}, pt: ${pt}\n`);

const syBalBefore = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
await vsend("Periphery.zapHbarToSy(2000 HBAR)", {
  account, address: periphery, abi: artPeriphery.abi, functionName: "zapHbarToSy",
  args: [market, account.address, 0n],
  value: parseEther("2000"), gas: 15_000_000n, gasPrice: GAS,
});
const syBalAfter = await pub.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const syReceived = syBalAfter - syBalBefore;
console.log(`SY received: ${syReceived}\n`);

await vsend("SY.approve(newMarket)", {
  account, address: shareToken, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

// New market must be INITIALIZED first (sets the AMM anchor). Then any
// extra SY+PT is added via addLiquidity proportionally.
const halfSy = syReceived / 2n;
const remainingSy = syReceived - halfSy;
await vsend(`Market.split(${halfSy})`, {
  account, address: market, abi: artMarket, functionName: "split",
  args: [halfSy], gas: 4_000_000n, gasPrice: GAS,
});

const ptBal = await pub.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`PT after split: ${ptBal}`);
await vsend("PT.approve(newMarket)", {
  account, address: pt, abi: erc20Abi, functionName: "approve",
  args: [market, (1n << 63n) - 1n], gas: 1_000_000n, gasPrice: GAS,
});

// Initialize with ~10% of the budget so we leave room for addLiquidity.
const initSy = remainingSy / 10n;
const initPt = ptBal / 10n;
const ANCHOR = BigInt("1200000000000000000"); // 1.2e18 = ~20% APR
const LN_FEE = BigInt("10000000000000000");   // 0.01e18 = 1%
const RESERVE = 50n;
await vsend(`Market.initialize(syIn=${initSy}, ptIn=${initPt}, anchor=1.2e18)`, {
  account, address: market, abi: artMarket, functionName: "initialize",
  args: [initSy, initPt, ANCHOR, LN_FEE, RESERVE],
  gas: 4_000_000n, gasPrice: GAS,
});

// Now add the remaining as proportional liquidity to deepen the pool.
const moreSy = remainingSy - initSy;
const morePt = ptBal - initPt;
await vsend(`Market.addLiquidity(syIn=${moreSy}, ptIn=${morePt}) — deepen pool`, {
  account, address: market, abi: artMarket, functionName: "addLiquidity",
  args: [moreSy, morePt, 1n, account.address],
  gas: 6_000_000n, gasPrice: GAS,
});

// ── 8. Persist ──
const out = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));
out.previousSY = out.contracts.saucerSwapLPYieldSource;
out.previousMarket = out.market.address;
out.contracts.saucerSwapLPYieldSource = getAddress(sy);
out.market = { address: market, expiry: EXPIRY.toString(), scalarRoot: SCALAR.toString(), suffix: SUFFIX, anchor: "1.2e18 — TBD by initialize next" };
out.xFixes_2_10_cascade = {
  ts: new Date().toISOString(),
  newSy: getAddress(sy),
  newMarket: market,
  oldSy: out.previousSY,
  oldMarket: out.previousMarket,
  reason: "X-2 / X-10 fix: SY adapter now has sweepHbar() + receive() so stuck HBAR is recoverable.",
};
writeFileSync(join(REPO, "deployments/295.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`  ✅ Cascade complete`);
console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  New SY:      ${sy}`);
console.log(`  New Market:  ${market}`);
console.log(`  Operator:    ${account.address}`);
console.log(`\n  NEXT: market.initialize(anchor=1.2e18), update Vercel + indexer + Supabase`);

sdkClient.close();
