#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  Fission Protocol — UUPS-proxy + freeze-PT clean-slate deploy (SDK path).
//
//  THIS IS THE AUTHORITATIVE MAINNET/TESTNET DEPLOY SCRIPT for the rebuilt
//  architecture. It supersedes scripts/deploy-rebuild.mjs (MDS-1: that deployed
//  the now-UUPS Factory/Periphery/Lens with OLD ctor args and NO proxy — locked,
//  owner-less implementations) and the periphery redeploy scripts.
//
//  Why the SDK and not `forge script --broadcast`:
//    - Big contract bytecode must go through the Hedera FileService (handled by
//      ContractCreateFlow automatically); plain eth_sendRawTransaction can't.
//    - ContractCreate caps at 15M gas; we size each call accordingly.
//    - HTS-precompile value-forwarding (SY.initShareToken / market.setTokens)
//      needs Hedera-native msg.value handling that revm broadcast mis-models.
//    - HTS auto-association needs setMaxAutomaticTokenAssociations(-1).
//
//  Deploy ORDER (each brain = implementation -> ERC1967Proxy -> initialize):
//    1.  StandardMarketDeployer            (plain helper)
//    2.  RewardsMarketDeployer             (plain helper)
//    3.  FissionFactory impl  + proxy(init)         -> FACTORY  = proxy addr
//    4.  FissionLens   impl   + proxy(init)         -> LENS     = proxy addr
//    5.  SaucerSwapLPYieldSource (SY adapter)       (plain; ctor only)
//    6.  SY.initShareToken{value}                   (creates HTS fSY + NPM approve)
//    7.  factory.proposeSY + confirmSY              (gov-gated; window=0 to bootstrap)
//    8.  factory.createRewardsMarket{value}         -> MARKET (decode MarketCreated)
//    9.  FissionPeriphery impl + proxy(init, [market])  -> PERIPHERY = proxy addr
//   10.  market.setPeriphery(PERIPHERY)             (MDS-2 — as MARKET ADMIN)
//   11.  ASSERT read-backs: factory.SY_REVIEW_WINDOW, periphery.owner /
//        upgradeAuthority, market.periphery == PERIPHERY, PT has a freeze key.
//
//  EVERYTHING points at PROXY addresses downstream (stable across upgrades).
//
//  NETWORK (env NETWORK = "mainnet" | "testnet", default mainnet):
//    mainnet (295): external addrs PINNED (deployments/295.json `external`).
//    testnet (296): external addrs are TODO PLACEHOLDERS — the script REFUSES to
//      run unless ALLOW_UNVERIFIED_CONFIG=1 is set, because the SaucerSwap V2 /
//      WHBAR / USDC testnet addresses below are researched-but-unverified
//      (see contracts/script/NetworkConfig.sol + docs/DEPLOY_RUNBOOK.md).
//
//  Reads .env:
//    NEW_DEPLOYER_KEY  ECDSA hex (required)   NEW_DEPLOYER_ID  (auto via mirror)
//    FACTORY_ADMIN MARKET_ADMIN MARKET_TREASURY SY_ADMIN  (default = deployer EVM)
//    PERIPHERY_OWNER (default deployer)  UPGRADE_AUTHORITY (default FACTORY_ADMIN)
//    SY_REVIEW_WINDOW (default 0 for bootstrap) MARKET_EXPIRY SCALAR_ROOT MARKET_SUFFIX
//
//  DOES NOT broadcast unless invoked with `--execute`. Default is DRY-RUN: it
//  loads artifacts, resolves config, prints the full plan, and exits WITHOUT
//  sending any transaction.
// ─────────────────────────────────────────────────────────────────────────────

import { Client, ContractCreateFlow, ContractCreateTransaction, FileAppendTransaction, FileCreateTransaction, Hbar, PrivateKey } from "@hashgraph/sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeDeployData,
  encodeFunctionData,
  parseEther,
  getAddress,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const EXECUTE = process.argv.includes("--execute");

function loadDotenv() {
  const p = join(REPO, ".env");
  if (!existsSync(p)) return;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const e = t.indexOf("=");
    if (e < 0) continue;
    const k = t.slice(0, e).trim();
    let v = t.slice(e + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

// ── Network config (mirrors contracts/script/NetworkConfig.sol) ──────────────
const NETWORK = (process.env.NETWORK || "mainnet").toLowerCase();
const NETS = {
  mainnet: {
    chainId: 295,
    rpc: process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api",
    mirror: "https://mainnet-public.mirrornode.hedera.com",
    sdk: () => Client.forMainnet(),
    minGasPrice: 1_100_000_000_000n, // Hashio floor 960 gwei -> bump
    verified: true,
    external: {
      // PINNED — deployments/295.json `external` + MainnetAddresses.sol
      V2_ROUTER: "0x00000000000000000000000000000000003c437A", // 0.0.3949434
      NPM: "0x00000000000000000000000000000000003DDbb9", // 0.0.4053945
      WHBAR_CONTRACT: "0x0000000000000000000000000000000000163B59", // 0.0.1456985
      WHBAR: "0x0000000000000000000000000000000000163B5a", // 0.0.1456986
      USDC: "0x000000000000000000000000000000000006f89a", // 0.0.456858
    },
    poolFee: 1500,
    tickLower: -887220,
    tickUpper: 887220,
  },
  testnet: {
    chainId: 296,
    rpc: process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api",
    mirror: "https://testnet.mirrornode.hedera.com",
    sdk: () => Client.forTestnet(),
    minGasPrice: 1_100_000_000_000n,
    verified: false, // TODO(testnet): flip once on-chain-verified
    external: {
      // TODO(testnet): research placeholders — VERIFY before --execute.
      //   SaucerSwapV2 SwapRouter 0.0.1414040, NPM 0.0.1308184,
      //   WHBAR contract 0.0.15057 / token 0.0.15058, USDC ~0.0.13078 (UNCONFIRMED)
      V2_ROUTER: "0x0000000000000000000000000000000000159398",
      NPM: "0x000000000000000000000000000000000013F618",
      WHBAR_CONTRACT: "0x0000000000000000000000000000000000003aD1",
      WHBAR: "0x0000000000000000000000000000000000003aD2",
      USDC: "0x0000000000000000000000000000000000003316",
    },
    poolFee: 1500,
    tickLower: -887220,
    tickUpper: 887220,
  },
};
const NET = NETS[NETWORK];
if (!NET) throw new Error(`Unknown NETWORK="${NETWORK}" (use mainnet | testnet)`);

if (!NET.verified && !(process.env.ALLOW_UNVERIFIED_CONFIG === "1")) {
  throw new Error(
    `${NETWORK} external addresses are RESEARCH PLACEHOLDERS (see NetworkConfig.sol). ` +
      `Verify them on-chain, then set ALLOW_UNVERIFIED_CONFIG=1 to proceed.`
  );
}

// ── Keys / clients ───────────────────────────────────────────────────────────
const keyHex = (process.env.NEW_DEPLOYER_KEY || "").replace(/^0x/, "").trim();
if (!keyHex) throw new Error("NEW_DEPLOYER_KEY missing in .env");
const opKey = PrivateKey.fromStringECDSA(keyHex);
const PK = "0x" + keyHex;
const account = privateKeyToAccount(PK);
const evmAddr = account.address;

let opIdStr = (process.env.NEW_DEPLOYER_ID || "").trim();
if (!opIdStr && EXECUTE) {
  const r = await fetch(`${NET.mirror}/api/v1/accounts/${evmAddr}`);
  opIdStr = (await r.json()).account;
}

const chain = {
  id: NET.chainId,
  name: `Hedera ${NETWORK}`,
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [NET.rpc] } },
};
const publicClient = createPublicClient({ chain, transport: http(NET.rpc) });
const walletClient = createWalletClient({ account, chain, transport: http(NET.rpc) });

let sdkClient = null;
if (EXECUTE) {
  sdkClient = NET.sdk().setOperator(opIdStr, opKey);
  sdkClient.setDefaultMaxTransactionFee(new Hbar(50));
  sdkClient.setDefaultMaxQueryPayment(new Hbar(5));
}

// ── Roles ────────────────────────────────────────────────────────────────────
const FACTORY_ADMIN = getAddress(process.env.FACTORY_ADMIN || evmAddr);
const MARKET_ADMIN = getAddress(process.env.MARKET_ADMIN || evmAddr);
const MARKET_TREASURY = getAddress(process.env.MARKET_TREASURY || evmAddr);
const SY_ADMIN = getAddress(process.env.SY_ADMIN || evmAddr);
const PERIPHERY_OWNER = getAddress(process.env.PERIPHERY_OWNER || evmAddr);
const UPGRADE_AUTHORITY = getAddress(process.env.UPGRADE_AUTHORITY || FACTORY_ADMIN);
const SY_REVIEW_WINDOW = BigInt(process.env.SY_REVIEW_WINDOW || "0");

const X = NET.external;
const NPM = getAddress(X.NPM);
const USDC = getAddress(X.USDC);
const WHBAR = getAddress(X.WHBAR);
const WHBAR_CONTRACT = getAddress(X.WHBAR_CONTRACT);
const V2_ROUTER = getAddress(X.V2_ROUTER);
const T0 = USDC.toLowerCase() < WHBAR.toLowerCase() ? USDC : WHBAR;
const T1 = USDC.toLowerCase() < WHBAR.toLowerCase() ? WHBAR : USDC;

// ── Artifacts ──────────────────────────────────────────────────────────────
function art(path) {
  const j = JSON.parse(readFileSync(join(REPO, "contracts/out", path), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
const artStd = art("StandardMarketDeployer.sol/StandardMarketDeployer.json");
const artRwd = art("RewardsMarketDeployer.sol/RewardsMarketDeployer.json");
const artFactory = art("FissionFactory.sol/FissionFactory.json");
const artLens = art("FissionLens.sol/FissionLens.json");
const artSY = art("SaucerSwapLPYieldSource.sol/SaucerSwapLPYieldSource.json");
const artPeriphery = art("FissionPeriphery.sol/FissionPeriphery.json");
const artMarket = art("FissionRewardsMarket.sol/FissionRewardsMarket.json");
const artProxy = art("ERC1967Proxy.sol/ERC1967Proxy.json");

// ── Plan banner ───────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════");
console.log(`  Fission UUPS-proxy deploy — ${NETWORK} (chain ${NET.chainId})`);
console.log(`  MODE: ${EXECUTE ? "EXECUTE (will broadcast)" : "DRY-RUN (no broadcast)"}`);
console.log("══════════════════════════════════════════════════════════════════");
console.log(`  Deployer         : ${evmAddr}${opIdStr ? ` (${opIdStr})` : ""}`);
console.log(`  Factory admin    : ${FACTORY_ADMIN}`);
console.log(`  Market admin     : ${MARKET_ADMIN}`);
console.log(`  Market treasury  : ${MARKET_TREASURY}`);
console.log(`  SY admin         : ${SY_ADMIN}`);
console.log(`  Periphery owner  : ${PERIPHERY_OWNER}`);
console.log(`  Upgrade authority: ${UPGRADE_AUTHORITY}`);
console.log(`  SY review window : ${SY_REVIEW_WINDOW}s`);
console.log(`  V2 router        : ${V2_ROUTER}`);
console.log(`  V3 NPM           : ${NPM}`);
console.log(`  WHBAR contract   : ${WHBAR_CONTRACT}`);
console.log(`  WHBAR token      : ${WHBAR}`);
console.log(`  USDC token       : ${USDC}`);
console.log(`  Config verified  : ${NET.verified}${NET.verified ? "" : " (UNVERIFIED placeholders)"}`);

if (!EXECUTE) {
  console.log("\n  DRY-RUN complete. Re-run with `--execute` to broadcast.");
  console.log("  See docs/DEPLOY_RUNBOOK.md for the full ordered procedure + checklist.");
  process.exit(0);
}

// ── Helpers (SDK contract-create + viem contract-call) ───────────────────────
const balance = await publicClient.getBalance({ address: evmAddr });
console.log(`\n  Balance          : ${(Number(balance) / 1e18).toFixed(2)} HBAR`);
if (balance < parseEther("100")) throw new Error("Insufficient balance (~925 HBAR for full deploy + market init).");

/// Deploy `initcode` (runtime bytecode + ABI-encoded ctor args, hex without 0x)
/// via ContractCreateFlow (FileService-backed; handles >6KB bytecode).
async function createContract({ name, initcodeHex, gas = 12_000_000, autoAssoc = true }) {
  console.log(`\n→ Deploy ${name} (gas ${gas})…`);
  // Hedera's FileService stores bytecode as HEX TEXT (the literal hex chars as
  // UTF-8 bytes); passing raw bytes => ERROR_DECODING_BYTESTRING. So encode the
  // hex string as utf8, NOT hex-decoded bytes.
  const buf = Buffer.from(initcodeHex.replace(/^0x/, ""), "utf8");

  // Small bytecode (≤6KB) fits one FileCreate — ContractCreateFlow is safe.
  if (buf.length <= 6000) {
    const flow = new ContractCreateFlow()
      .setBytecode(buf)
      .setGas(gas)
      .setAdminKey(opKey.publicKey);
    if (autoAssoc) flow.setMaxAutomaticTokenAssociations(-1);
    const cid = (await (await flow.execute(sdkClient)).getReceipt(sdkClient)).contractId;
    const addr = getAddress("0x" + cid.toSolidityAddress());
    console.log(`  ✓ ${name} @ ${addr} (${cid.toString()})`);
    return addr;
  }

  // Big bytecode: manual FileCreate + batched FileAppend (retry on TRANSACTION_EXPIRED)
  // + ContractCreate. ContractCreateFlow's internal append has no retry / maxChunks
  // control — that's what expired the first attempt on the big deployer.
  console.log(`  · ${buf.length}b — manual FileCreate + FileAppend (chunked + retry)`);
  const fc = await new FileCreateTransaction()
    .setKeys([opKey.publicKey])
    .setContents(buf.subarray(0, 2048))
    .setMaxTransactionFee(new Hbar(5))
    .execute(sdkClient);
  const fileId = (await fc.getReceipt(sdkClient)).fileId;
  console.log(`  · FileCreate → ${fileId.toString()}`);

  const remainder = buf.subarray(2048);
  const BATCH = 32 * 1024;
  for (let off = 0; off < remainder.length; off += BATCH) {
    const batch = remainder.subarray(off, Math.min(off + BATCH, remainder.length));
    let attempt = 0;
    while (true) {
      try {
        await new FileAppendTransaction()
          .setFileId(fileId)
          .setContents(batch)
          .setMaxChunks(20)
          .setMaxTransactionFee(new Hbar(20))
          .execute(sdkClient);
        console.log(`  · FileAppend +${batch.length}b @ ${off}`);
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 4 || !String(e).includes("TRANSACTION_EXPIRED")) throw e;
        console.log(`  · retry append @ ${off} (attempt ${attempt})`);
      }
    }
  }

  const cc = new ContractCreateTransaction()
    .setBytecodeFileId(fileId)
    .setGas(gas)
    .setAdminKey(opKey.publicKey)
    .setMaxTransactionFee(new Hbar(50));
  if (autoAssoc) cc.setMaxAutomaticTokenAssociations(-1);
  const cid = (await (await cc.execute(sdkClient)).getReceipt(sdkClient)).contractId;
  const addr = getAddress("0x" + cid.toSolidityAddress());
  console.log(`  ✓ ${name} @ ${addr} (${cid.toString()})`);
  return addr;
}

/// Deploy an implementation, then its ERC1967Proxy initialized atomically.
/// Returns the PROXY address (the address consumers must use).
async function deployBrain({ name, art: a, initArgs, initGas = 4_000_000, implGas = 12_000_000 }) {
  const implInit = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [] });
  const impl = await createContract({ name: `${name} (impl)`, initcodeHex: implInit, implGas, gas: implGas });
  const initData = encodeFunctionData({ abi: a.abi, functionName: "initialize", args: initArgs });
  const proxyInit = encodeDeployData({
    abi: artProxy.abi,
    bytecode: artProxy.bytecode,
    args: [impl, initData],
  });
  const proxy = await createContract({ name: `${name} (proxy)`, initcodeHex: proxyInit, gas: initGas + 6_000_000 });
  return { impl, proxy };
}

async function call({ name, address, abi, functionName, args, value = 0n, gas = 3_000_000n }) {
  console.log(`\n→ ${name}.${functionName}(…)`);
  const { request } = await publicClient
    .simulateContract({ account, address, abi, functionName, args, value, gas, gasPrice: NET.minGasPrice })
    .catch(() => ({
      request: { account, address, abi, functionName, args, value, gas, gasPrice: NET.minGasPrice },
    }));
  const hash = await walletClient.writeContract(request);
  const rec = await publicClient.waitForTransactionReceipt({ hash });
  if (rec.status !== "success") throw new Error(`${name}.${functionName} failed`);
  console.log(`  ✓ ${hash}`);
  return rec;
}

async function read({ address, abi, functionName, args = [] }) {
  return publicClient.readContract({ address, abi, functionName, args });
}

// ── 1+2. Market deployers ──
const stdDeployer = process.env.STD_DEPLOYER || await createContract({
  name: "StandardMarketDeployer",
  initcodeHex: encodeDeployData({ abi: artStd.abi, bytecode: artStd.bytecode, args: [] }),
  gas: 10_000_000,
});
const rwdDeployer = process.env.RWD_DEPLOYER || await createContract({
  name: "RewardsMarketDeployer",
  initcodeHex: encodeDeployData({ abi: artRwd.abi, bytecode: artRwd.bytecode, args: [] }),
  gas: 12_000_000,
});

// ── 3. FissionFactory (impl + proxy) ──
const factory = process.env.FACTORY_PROXY ? { proxy: process.env.FACTORY_PROXY } : await deployBrain({
  name: "FissionFactory",
  art: artFactory,
  initArgs: [FACTORY_ADMIN, MARKET_ADMIN, MARKET_TREASURY, stdDeployer, rwdDeployer, SY_REVIEW_WINDOW],
  implGas: 6_000_000,
});

// ── 4. FissionLens (impl + proxy) ──
const lens = process.env.LENS_PROXY ? { proxy: process.env.LENS_PROXY } : await deployBrain({
  name: "FissionLens",
  art: artLens,
  initArgs: [UPGRADE_AUTHORITY],
  implGas: 3_000_000,
  initGas: 2_000_000,
});

// ── 5. SaucerSwapLPYieldSource (plain) ──
const sy = process.env.SY_ADDR || await createContract({
  name: "SaucerSwapLPYieldSource",
  initcodeHex: encodeDeployData({
    abi: artSY.abi,
    bytecode: artSY.bytecode,
    args: [
      `Fission SY SaucerSwap V2 USDC-WHBAR`,
      "fSY-USDC-WHBAR",
      T0,
      T1,
      NET.poolFee,
      NET.tickLower,
      NET.tickUpper,
      NPM,
      SY_ADMIN,
      0,
    ],
  }),
  gas: 10_000_000,
});

// ── 6+7. SY.initShareToken + proposeSY + confirmSY (SKIP_SY_SETUP=1 on resume) ──
if (!process.env.SKIP_SY_SETUP) {
  await call({ name: "SY", address: sy, abi: artSY.abi, functionName: "initShareToken", args: [], value: parseEther("20"), gas: 4_000_000n });
  await call({ name: "Factory", address: factory.proxy, abi: artFactory.abi, functionName: "proposeSY", args: [sy], gas: 1_000_000n });
  if (SY_REVIEW_WINDOW > 0n) {
    console.log(`\n  ⏳ SY_REVIEW_WINDOW=${SY_REVIEW_WINDOW}s — confirmSY + createMarket are SEPARATE gov steps.`);
  }
  await call({ name: "Factory", address: factory.proxy, abi: artFactory.abi, functionName: "confirmSY", args: [sy], gas: 1_000_000n });
} else {
  console.log("  ↺ SKIP_SY_SETUP — SY already initialized + whitelisted");
}

// ── 8. factory.createRewardsMarket{value: 30 HBAR} ──
const EXPIRY = BigInt(process.env.MARKET_EXPIRY || Math.floor(Date.now() / 1000) + 86400 * 90);
const SCALAR_ROOT = BigInt(process.env.SCALAR_ROOT || "5000000000000000000");
const SUFFIX = process.env.MARKET_SUFFIX || `USDC-WHBAR-${new Date(Number(EXPIRY) * 1000).toISOString().slice(0, 10)}`;
const createRec = await call({
  name: "Factory",
  address: factory.proxy,
  abi: artFactory.abi,
  functionName: "createRewardsMarket",
  args: [sy, EXPIRY, SCALAR_ROOT, SUFFIX],
  value: parseEther(process.env.MARKET_HBAR || "90"),
  gas: 14_000_000n,
});
let market = null;
let ptAddr = null;
for (const log of createRec.logs) {
  try {
    const ev = decodeEventLog({ abi: artFactory.abi, data: log.data, topics: log.topics });
    if (ev.eventName === "MarketCreated") {
      market = ev.args.market;
      ptAddr = ev.args.pt;
      console.log(`  Market: ${market} (PT=${ev.args.pt} YT=${ev.args.yt} LP=${ev.args.lp})`);
      break;
    }
  } catch {}
}
if (!market) throw new Error("MarketCreated event not found");

// ── 9. FissionPeriphery (impl + proxy), pre-register the new market ──
const periphery = await deployBrain({
  name: "FissionPeriphery",
  art: artPeriphery,
  initArgs: [WHBAR_CONTRACT, WHBAR, USDC, V2_ROUTER, NPM, PERIPHERY_OWNER, UPGRADE_AUTHORITY, [market]],
  implGas: 12_000_000,
  initGas: 9_000_000, // initialize associates USDC/WHBAR + registers the market (HTS-heavy)
});

// ── 10. market.setPeriphery(PERIPHERY) — MDS-2 — as MARKET ADMIN ──
// NOTE: requires the deployer to BE the market admin (solo/operator-first). If
// MARKET_ADMIN is a Safe/ThresholdKey, this is a post-deploy gov action instead.
if (MARKET_ADMIN.toLowerCase() === evmAddr.toLowerCase()) {
  await call({ name: "Market", address: market, abi: artMarket.abi, functionName: "setPeriphery", args: [periphery.proxy], gas: 1_500_000n });
} else {
  console.log(`\n  ⚠ MARKET_ADMIN (${MARKET_ADMIN}) != deployer — call market.setPeriphery(${periphery.proxy}) from the admin (Safe/ThresholdKey).`);
}

// ── 11. ASSERT read-backs ──
console.log("\n→ Asserting read-backs…");
const win = await read({ address: factory.proxy, abi: artFactory.abi, functionName: "SY_REVIEW_WINDOW" });
if (BigInt(win) !== SY_REVIEW_WINDOW) throw new Error(`factory.SY_REVIEW_WINDOW ${win} != ${SY_REVIEW_WINDOW}`);
const pOwner = await read({ address: periphery.proxy, abi: artPeriphery.abi, functionName: "owner" });
if (getAddress(pOwner) !== PERIPHERY_OWNER) throw new Error(`periphery.owner ${pOwner} != ${PERIPHERY_OWNER}`);
const pAuth = await read({ address: periphery.proxy, abi: artPeriphery.abi, functionName: "upgradeAuthority" });
if (getAddress(pAuth) === getAddress("0x0000000000000000000000000000000000000000")) throw new Error("periphery.upgradeAuthority is zero");
const reg = await read({ address: periphery.proxy, abi: artPeriphery.abi, functionName: "marketRegistered", args: [market] });
if (!reg) throw new Error("market not registered on periphery");

if (MARKET_ADMIN.toLowerCase() === evmAddr.toLowerCase()) {
  const mp = await read({ address: market, abi: artMarket.abi, functionName: "periphery" });
  if (getAddress(mp) !== periphery.proxy) throw new Error(`market.periphery ${mp} != ${periphery.proxy}`);
  console.log("  ✓ market.periphery == periphery proxy");
}

// PT freeze-key check via Mirror Node getTokenInfo (HTS truth source).
try {
  const tokenNum = "0.0." + parseInt(ptAddr.slice(-10), 16); // long-zero -> id (best-effort)
  const r = await fetch(`${NET.mirror}/api/v1/tokens/${tokenNum}`);
  const info = await r.json();
  const hasFreeze = info && info.freeze_key && info.freeze_key.key;
  console.log(`  ${hasFreeze ? "✓" : "⚠"} PT (${ptAddr}) freeze_key present: ${!!hasFreeze}`);
  if (!hasFreeze) console.log("    (verify manually: PT MUST be freeze-by-default)");
} catch (e) {
  console.log(`  ⚠ could not auto-verify PT freeze key — check Mirror Node getTokenInfo for ${ptAddr}`);
}
console.log("  ✓ read-backs OK");

// ── Persist ──
const deployDir = join(REPO, "deployments");
mkdirSync(deployDir, { recursive: true });
const outPath = join(deployDir, `${NET.chainId}.json`);
const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const out = {
  chainId: NET.chainId,
  network: NETWORK,
  deployedAt: new Date().toISOString(),
  deployer: evmAddr,
  architecture: "uups-proxy + freeze-pt",
  roles: { factoryAdmin: FACTORY_ADMIN, marketAdmin: MARKET_ADMIN, marketTreasury: MARKET_TREASURY, syAdmin: SY_ADMIN, peripheryOwner: PERIPHERY_OWNER, upgradeAuthority: UPGRADE_AUTHORITY },
  external: { NPM, USDC, WHBAR, WHBAR_CONTRACT, V2_ROUTER, poolFee: NET.poolFee, tickLower: NET.tickLower, tickUpper: NET.tickUpper },
  contracts: {
    standardMarketDeployer: stdDeployer,
    rewardsMarketDeployer: rwdDeployer,
    factoryImpl: factory.impl,
    factory: factory.proxy,
    lensImpl: lens.impl,
    lens: lens.proxy,
    saucerSwapLPYieldSource: sy,
    peripheryImpl: periphery.impl,
    periphery: periphery.proxy,
  },
  market: { address: market, pt: ptAddr, expiry: EXPIRY.toString(), scalarRoot: SCALAR_ROOT.toString(), suffix: SUFFIX },
  abandoned: existing.abandoned || existing,
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

console.log("\n══════════════════════════════════════════════════════════════════");
console.log(`  ✅ UUPS-proxy deploy complete — wrote ${outPath}`);
console.log("══════════════════════════════════════════════════════════════════");
console.log(`  Factory   (proxy): ${factory.proxy}`);
console.log(`  Periphery (proxy): ${periphery.proxy}`);
console.log(`  Lens      (proxy): ${lens.proxy}`);
console.log(`  SY adapter       : ${sy}`);
console.log(`  Market           : ${market}`);
console.log("\n  NEXT: seed liquidity, frontend cutover, smoke each route, operator-last handoff.");
sdkClient.close();
