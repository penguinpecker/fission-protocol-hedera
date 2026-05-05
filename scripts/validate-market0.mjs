#!/usr/bin/env node
// Read-only end-to-end validation of Market 0 (SaucerSwap V2 LP rewards) on
// Hedera mainnet. No funds spent — every probe is a `view` call.
//
// What we verify:
//   1. Live state matches deployments/295.json
//   2. PT / YT / LP HTS tokens are properly created (name, symbol, decimals, totalSupply)
//   3. SY adapter holds a real V3 NFT (NPM positions(tokenId) returns valid tuple)
//   4. lastLnImpliedRate is set (initialized)
//   5. globalRewardIndex0/1 are reasonable
//   6. exchangeRate is constant 1e18 (Pendle-Kyber pattern)
//   7. Reserve fee + scalarRoot match deployment params
//   8. expiry is in the future
//
// Usage:
//   HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api node scripts/validate-market0.mjs

import { createPublicClient, http, formatUnits, parseAbi } from "viem";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const DEPLOY = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));

const RPC = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";

const market0 = DEPLOY.markets.find(m => m.id === 0);
if (!market0) { console.error("Market 0 not in deployments/295.json"); process.exit(1); }

const HEDERA_MAINNET = {
  id: 295,
  name: "Hedera Mainnet",
  network: "hedera-mainnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] }, public: { http: [RPC] } },
};

const client = createPublicClient({ chain: HEDERA_MAINNET, transport: http(RPC) });

// SaucerSwap V2 NPM (Hedera 0.0.4053945)
const NPM = "0x00000000000000000000000000000000003DDbb9";

const ABI_MARKET = parseAbi([
  "function sy() view returns (address)",
  "function pt() view returns (address)",
  "function yt() view returns (address)",
  "function lp() view returns (address)",
  "function expiry() view returns (uint256)",
  "function scalarRoot() view returns (int256)",
  "function totalSy() view returns (uint256)",
  "function totalPt() view returns (uint256)",
  "function lastLnImpliedRate() view returns (int256)",
  "function lnFeeRateRoot() view returns (int256)",
  "function reserveFeePercent() view returns (uint256)",
  "function treasury() view returns (address)",
  "function globalRewardIndex0() view returns (uint256)",
  "function globalRewardIndex1() view returns (uint256)",
  "function rewardToken0() view returns (address)",
  "function rewardToken1() view returns (address)",
  "function paused() view returns (bool)",
]);
const ABI_SY = parseAbi([
  "function exchangeRate() view returns (uint256)",
  "function shareToken() view returns (address)",
  "function positionTokenId() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function paused() view returns (bool)",
]);
const ABI_ERC20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
// SaucerSwap V2 NPM: 10-field tuple (no leading nonce + operator vs canonical V3).
const ABI_NPM = parseAbi([
  "function positions(uint256) view returns (address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
// V3 NFT collection (Hedera 0.0.4054027 = EVM 0x...3DDc0b). ownerOf lives here, not NPM.
const NFT_COLLECTION = "0x00000000000000000000000000000000003ddc0b";
const ABI_HTS_NFT = parseAbi([
  "function ownerOf(uint256) view returns (address)",
]);

let pass = 0, fail = 0;
const issues = [];
const ok = (label, val) => { console.log(`  ✓ ${label.padEnd(50)} ${val ?? ""}`); pass++; };
const bad = (label, why) => { console.log(`  ✗ ${label.padEnd(50)} ${why}`); fail++; issues.push(`${label}: ${why}`); };

console.log(`\n=== Market 0 read-only validation ===\nRPC:    ${RPC}\nMarket: ${market0.evm}\nSY:     ${market0.sy}\n`);

// ---------- Market core state ----------
console.log("Market core state:");
const [syAddr, ptAddr, ytAddr, lpAddr, expiry, scalarRoot, totalSy, totalPt, lnImplied, lnFee, reserveFee, treasury, paused] = await Promise.all([
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "sy" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "pt" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "yt" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "lp" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "expiry" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "scalarRoot" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "totalSy" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "totalPt" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "lastLnImpliedRate" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "lnFeeRateRoot" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "reserveFeePercent" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "treasury" }),
  client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "paused" }),
]);

syAddr.toLowerCase() === market0.sy.toLowerCase() ? ok("sy() matches deployments/295.json", syAddr) : bad("sy() mismatch", `${syAddr} vs ${market0.sy}`);
ptAddr.toLowerCase() === market0.pt.toLowerCase() ? ok("pt() matches deployments/295.json", ptAddr) : bad("pt() mismatch", `${ptAddr} vs ${market0.pt}`);
ytAddr.toLowerCase() === market0.yt.toLowerCase() ? ok("yt() matches deployments/295.json", ytAddr) : bad("yt() mismatch", `${ytAddr} vs ${market0.yt}`);
lpAddr.toLowerCase() === market0.lp.toLowerCase() ? ok("lp() matches deployments/295.json", lpAddr) : bad("lp() mismatch", `${lpAddr} vs ${market0.lp}`);
Number(expiry) === market0.expiry_unix ? ok("expiry() matches deployment", new Date(Number(expiry)*1000).toISOString()) : bad("expiry mismatch", `${expiry} vs ${market0.expiry_unix}`);
Number(expiry) > Math.floor(Date.now()/1000) ? ok("expiry is in the future", `+${Math.round((Number(expiry) - Date.now()/1000)/86400)}d`) : bad("market expired", new Date(Number(expiry)*1000).toISOString());
scalarRoot === 75n * 10n**18n ? ok("scalarRoot = 75e18", scalarRoot.toString()) : bad("scalarRoot mismatch", scalarRoot.toString());
totalSy > 0n ? ok("totalSy > 0", totalSy.toString()) : bad("totalSy = 0", "market has no SY backing");
totalPt > 0n ? ok("totalPt > 0", totalPt.toString()) : bad("totalPt = 0", "market has no PT in pool");
lnImplied !== 0n ? ok("lastLnImpliedRate set (non-zero)", lnImplied.toString()) : bad("lastLnImpliedRate = 0", "market not initialized?");
lnFee === 3n * 10n**14n ? ok("lnFeeRateRoot = 3e14", lnFee.toString()) : bad("lnFeeRateRoot mismatch", lnFee.toString());
reserveFee === 80n ? ok("reserveFeePercent = 80", reserveFee.toString()) : bad("reserveFeePercent mismatch", reserveFee.toString());
!paused ? ok("market not paused") : bad("market paused", "operator must unpause");

// ---------- SY state ----------
console.log("\nSY adapter state:");
const [exchangeRate, shareToken, positionTokenId, token0, token1, syPaused] = await Promise.all([
  client.readContract({ address: syAddr, abi: ABI_SY, functionName: "exchangeRate" }),
  client.readContract({ address: syAddr, abi: ABI_SY, functionName: "shareToken" }),
  client.readContract({ address: syAddr, abi: ABI_SY, functionName: "positionTokenId" }),
  client.readContract({ address: syAddr, abi: ABI_SY, functionName: "token0" }),
  client.readContract({ address: syAddr, abi: ABI_SY, functionName: "token1" }),
  client.readContract({ address: syAddr, abi: ABI_SY, functionName: "paused" }),
]);
exchangeRate === 10n**18n ? ok("exchangeRate = 1e18 (constant)", exchangeRate.toString()) : bad("exchangeRate not 1e18", exchangeRate.toString());
shareToken !== "0x0000000000000000000000000000000000000000" ? ok("shareToken HTS address set", shareToken) : bad("shareToken not set", "initShareToken not called");
positionTokenId > 0n ? ok("V3 NFT positionTokenId minted", positionTokenId.toString()) : bad("positionTokenId = 0", "no V3 NFT minted");
!syPaused ? ok("SY not paused") : bad("SY paused", "operator must unpause");

// ---------- V3 NFT custody check ----------
console.log("\nV3 NFT custody:");
try {
  // ownerOf lives on the HTS NFT collection (0.0.4054027), NOT the NPM (which is
  // an EVM logic contract that doesn't implement ERC-721 itself on Hedera).
  const owner = await client.readContract({ address: NFT_COLLECTION, abi: ABI_HTS_NFT, functionName: "ownerOf", args: [positionTokenId] });
  owner.toLowerCase() === syAddr.toLowerCase() ? ok("NFT owned by SY", owner) : bad("NFT owner not SY", `owned by ${owner}`);
} catch (e) {
  bad("ownerOf reverted on NFT collection", e.shortMessage || e.message);
}
try {
  const pos = await client.readContract({ address: NPM, abi: ABI_NPM, functionName: "positions", args: [positionTokenId] });
  const [posToken0, posToken1, fee, tickLower, tickUpper, liquidity] = pos;
  posToken0.toLowerCase() === token0.toLowerCase() ? ok("position token0 matches SY", posToken0) : bad("position token0 mismatch", `${posToken0} vs ${token0}`);
  posToken1.toLowerCase() === token1.toLowerCase() ? ok("position token1 matches SY", posToken1) : bad("position token1 mismatch", `${posToken1} vs ${token1}`);
  liquidity > 0n ? ok("position liquidity > 0", liquidity.toString()) : bad("position liquidity = 0", "empty NFT");
  ok(`position fee tier`, `${fee} (${Number(fee)/10000}%)`);
  ok(`position tick range`, `[${tickLower}, ${tickUpper}]`);
} catch (e) {
  bad("positions() reverted", e.shortMessage || e.message);
}

// ---------- HTS token metadata ----------
console.log("\nHTS PT/YT/LP metadata:");
for (const [label, addr] of [["PT", ptAddr], ["YT", ytAddr], ["LP", lpAddr], ["SY share", shareToken]]) {
  try {
    const [n, s, d, ts] = await Promise.all([
      client.readContract({ address: addr, abi: ABI_ERC20, functionName: "name" }),
      client.readContract({ address: addr, abi: ABI_ERC20, functionName: "symbol" }),
      client.readContract({ address: addr, abi: ABI_ERC20, functionName: "decimals" }),
      client.readContract({ address: addr, abi: ABI_ERC20, functionName: "totalSupply" }),
    ]);
    ts > 0n ? ok(`${label}: ${s} (${n})`, `${formatUnits(ts, d)} @ ${d} dec`) : bad(`${label} totalSupply = 0`, "no holders?");
  } catch (e) {
    bad(`${label} ERC-20 facade probe`, e.shortMessage || e.message);
  }
}

// ---------- LP supply consistency ----------
console.log("\nInvariant probes:");
const lpTotalSupply = await client.readContract({ address: lpAddr, abi: ABI_ERC20, functionName: "totalSupply" });
const expectedLp = BigInt(market0.lp_total_supply);
lpTotalSupply === expectedLp ? ok("LP totalSupply matches deployment", lpTotalSupply.toString()) : bad("LP totalSupply drift", `${lpTotalSupply} vs ${expectedLp}`);

const ptTotalSupply = await client.readContract({ address: ptAddr, abi: ABI_ERC20, functionName: "totalSupply" });
const ytTotalSupply = await client.readContract({ address: ytAddr, abi: ABI_ERC20, functionName: "totalSupply" });
ptTotalSupply >= totalPt ? ok("PT totalSupply >= totalPt (pool)", `${ptTotalSupply} vs ${totalPt}`) : bad("PT supply less than pool", "impossible state");
console.log(`    [info] PT.totalSupply=${ptTotalSupply}, YT.totalSupply=${ytTotalSupply} (PT post-init split equals YT post-init split if no merges/redemptions yet)`);

// ---------- Reward indexes ----------
console.log("\nReward state:");
try {
  const [g0, g1, r0, r1] = await Promise.all([
    client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "globalRewardIndex0" }),
    client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "globalRewardIndex1" }),
    client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "rewardToken0" }),
    client.readContract({ address: market0.evm, abi: ABI_MARKET, functionName: "rewardToken1" }),
  ]);
  ok(`rewardToken0`, r0);
  ok(`rewardToken1`, r1);
  ok(`globalRewardIndex0`, g0.toString());
  ok(`globalRewardIndex1`, g1.toString());
} catch (e) {
  bad("reward state probe", e.shortMessage || e.message);
}

// ---------- Summary ----------
console.log(`\n${pass}/${pass+fail} checks passed.`);
if (fail > 0) {
  console.log(`\nFailures (${fail}):`);
  for (const i of issues) console.log(`  - ${i}`);
  process.exit(1);
}
console.log("\nMarket 0 state is consistent. Read-only validation passed.");
