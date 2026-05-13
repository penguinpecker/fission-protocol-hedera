#!/usr/bin/env node
// Sourcify v1/v2 verification driver for HashScan + sourcify.dev.
//
// Posts the prepared standard-input.json bundle (from
// audits/hashscan/<Name>/standard-input.json) to one or more Sourcify-compatible
// servers using several payload shapes, until a `partial` or `perfect` match
// is reported.
//
// Endpoints tried, in order, for each contract:
//   1) <server>/verify/solc-json   (Sourcify v1 JSON, bare contractName)
//   2) <server>/verify             (Sourcify v1 multipart, source files + metadata)
//   3) <server>/verify/solc-json   (Sourcify v1 JSON, with creatorTxHash for creation-bytecode match)
//
// Defaults:
//   - Servers: HashScan mirror (https://server-verify.hashscan.io) primary;
//              sourcify.dev/server secondary if HASH only.
//   - Chain ID: 295 (Hedera mainnet).
//
// Usage:
//   node scripts/sourcify-v2.mjs                         # verify all 4 default targets
//   node scripts/sourcify-v2.mjs FissionZap              # single contract
//   SOURCIFY_URL=https://sourcify.dev/server node scripts/sourcify-v2.mjs FissionZap
//
// Constructor args for FissionZap are looked up from deployments/295.json
// (constructor field) and abi-encoded.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const CHAIN_ID = process.env.CHAIN_ID || "295";
const DEFAULT_SERVER = process.env.SOURCIFY_URL || "https://server-verify.hashscan.io";
const FALLBACK_SERVER = "https://sourcify.dev/server";

const DEPLOY = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));

const TARGETS = {
  FissionFactory:         { address: DEPLOY.factory.evm,            hederaId: "0.0.10465459" },
  StandardMarketDeployer: { address: DEPLOY.standard_deployer.evm,  hederaId: "0.0.10465455" },
  RewardsMarketDeployer:  { address: DEPLOY.rewards_deployer.evm,   hederaId: "0.0.10465457" },
  FissionZap:             { address: DEPLOY.fission_zap.evm,        hederaId: "0.0.10475908",
                            constructorArgs: [
                              DEPLOY.fission_zap.constructor.whbar_contract,
                              DEPLOY.fission_zap.constructor.whbar_token,
                              DEPLOY.fission_zap.constructor.usdc_token,
                              DEPLOY.fission_zap.constructor.swap_router,
                            ]},
};

function leftPad(hex32) {
  const h = hex32.replace(/^0x/, "").toLowerCase();
  return h.padStart(64, "0");
}
function abiEncodeAddresses(addrs) {
  return "0x" + addrs.map(leftPad).join("");
}

async function fetchCreatorTxHash(hederaId) {
  // Hedera mirror returns Ethereum-style hash for HAPI contract creates.
  const url = `https://mainnet-public.mirrornode.hedera.com/api/v1/contracts/${hederaId}/results?limit=1&order=asc`;
  const r = await fetch(url);
  const j = await r.json();
  return j.results?.[0]?.hash || null;
}

async function checkStatus(server, address) {
  const url = `${server}/check-all-by-addresses?addresses=${address}&chainIds=${CHAIN_ID}`;
  const r = await fetch(url);
  const j = await r.json();
  const entry = Array.isArray(j) ? j[0] : null;
  const inner = entry?.chainIds?.[0]?.status;
  return inner || entry?.status || "unknown";
}

function loadBundle(name) {
  const p = join(REPO, "audits/hashscan", name, "standard-input.json");
  if (!existsSync(p)) throw new Error(`missing bundle: ${p}`);
  const stdInput = JSON.parse(readFileSync(p, "utf8"));
  // Pull compilerVersion + contractName from artifact metadata.
  const artifactPath = join(REPO, "contracts/out", `${name}.sol`, `${name}.json`);
  const art = JSON.parse(readFileSync(artifactPath, "utf8"));
  const meta = JSON.parse(art.rawMetadata);
  const target = meta.settings.compilationTarget;
  const targetPath = Object.keys(target)[0];
  const contractName = target[targetPath];
  return {
    stdInput,
    compilerVersion: `v${meta.compiler.version}`,
    contractName,
    targetPath,
    metadata: meta,
    artifact: art,
  };
}

async function trySolcJson(server, address, bundle, opts = {}) {
  const payload = {
    address,
    chain: CHAIN_ID,
    compilerVersion: bundle.compilerVersion,
    contractName: bundle.contractName,
    files: { "input.json": JSON.stringify(bundle.stdInput) },
  };
  if (opts.creatorTxHash) payload.creatorTxHash = opts.creatorTxHash;
  if (opts.constructorArguments) payload.constructorArguments = opts.constructorArguments;
  const r = await fetch(`${server}/verify/solc-json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { http: r.status, body, endpoint: "/verify/solc-json" };
}

async function tryFilesUpload(server, address, bundle, opts = {}) {
  // Sourcify v1 /verify takes files = { "metadata.json": ..., "<path>": <source> }
  const files = { "metadata.json": JSON.stringify(bundle.metadata) };
  for (const [srcPath, val] of Object.entries(bundle.stdInput.sources)) {
    files[srcPath] = val.content;
  }
  const payload = { address, chain: CHAIN_ID, files };
  if (opts.creatorTxHash) payload.creatorTxHash = opts.creatorTxHash;
  if (opts.chosenContract != null) payload.chosenContract = opts.chosenContract;
  const r = await fetch(`${server}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { http: r.status, body, endpoint: "/verify" };
}

function attemptStatus(res) {
  // Sourcify v1 success looks like:
  //   { result: [{ address, chainId, status: "partial"|"perfect", storageTimestamp? }] }
  // Errors look like { error: "..." } or { message: "..." } with HTTP 4xx/5xx.
  const b = res.body;
  if (Array.isArray(b?.result)) {
    const s = b.result[0]?.status;
    if (s === "perfect" || s === "partial") return s;
  }
  return null;
}

async function verifyOne(server, name) {
  const target = TARGETS[name];
  if (!target) throw new Error(`unknown target: ${name}`);
  console.log(`\n=== ${name} @ ${target.address}  →  ${server}`);

  // Quick pre-check
  let pre = await checkStatus(server, target.address);
  console.log(`  pre-check: ${pre}`);
  if (pre === "partial" || pre === "perfect") {
    console.log(`  [SKIP] already ${pre}`);
    return { name, status: pre, via: "pre-existing" };
  }

  const bundle = loadBundle(name);

  // Attempt 1: solc-json, bare contractName
  console.log(`  → POST /verify/solc-json (contractName=${bundle.contractName})`);
  let res = await trySolcJson(server, target.address, bundle);
  console.log(`     HTTP ${res.http} :: ${typeof res.body === "string" ? res.body.slice(0,200) : JSON.stringify(res.body).slice(0,400)}`);
  let s = attemptStatus(res);
  if (s) {
    console.log(`  [OK] ${s} via /verify/solc-json`);
    return { name, status: s, via: "solc-json" };
  }

  // Attempt 2: solc-json with creatorTxHash (creation-bytecode match)
  const creatorTxHash = await fetchCreatorTxHash(target.hederaId);
  if (creatorTxHash) {
    console.log(`  → POST /verify/solc-json with creatorTxHash=${creatorTxHash}`);
    res = await trySolcJson(server, target.address, bundle, { creatorTxHash });
    console.log(`     HTTP ${res.http} :: ${typeof res.body === "string" ? res.body.slice(0,200) : JSON.stringify(res.body).slice(0,400)}`);
    s = attemptStatus(res);
    if (s) {
      console.log(`  [OK] ${s} via /verify/solc-json + creatorTxHash`);
      return { name, status: s, via: "solc-json+creatorTxHash" };
    }
  }

  // Attempt 3: files mode (metadata + sources)
  console.log(`  → POST /verify (files mode)`);
  res = await tryFilesUpload(server, target.address, bundle);
  console.log(`     HTTP ${res.http} :: ${typeof res.body === "string" ? res.body.slice(0,200) : JSON.stringify(res.body).slice(0,400)}`);
  s = attemptStatus(res);
  if (s) {
    console.log(`  [OK] ${s} via /verify (files)`);
    return { name, status: s, via: "files" };
  }

  // Attempt 4: files mode + creatorTxHash + constructorArguments if known
  if (creatorTxHash) {
    const opts = { creatorTxHash };
    if (target.constructorArgs) opts.constructorArguments = abiEncodeAddresses(target.constructorArgs);
    console.log(`  → POST /verify (files) + creatorTxHash${target.constructorArgs ? " + constructorArguments" : ""}`);
    res = await tryFilesUpload(server, target.address, bundle, opts);
    console.log(`     HTTP ${res.http} :: ${typeof res.body === "string" ? res.body.slice(0,200) : JSON.stringify(res.body).slice(0,400)}`);
    s = attemptStatus(res);
    if (s) {
      console.log(`  [OK] ${s} via /verify (files+creatorTx)`);
      return { name, status: s, via: "files+creatorTxHash" };
    }
  }

  // Final re-check (some servers return on a queue rather than synchronously)
  const final = await checkStatus(server, target.address);
  console.log(`  post-check: ${final}`);
  return { name, status: final, via: "post-check" };
}

const arg = process.argv[2];
const wanted = arg ? [arg] : Object.keys(TARGETS);
const results = [];
for (const name of wanted) {
  try {
    const r = await verifyOne(DEFAULT_SERVER, name);
    results.push({ ...r, server: DEFAULT_SERVER });
  } catch (e) {
    console.error(`  [ERR] ${name}: ${e.message}`);
    results.push({ name, status: "error", error: e.message, server: DEFAULT_SERVER });
  }
}

console.log("\n=== Final status ===");
for (const r of results) {
  console.log(`  ${r.name.padEnd(24)} ${r.status.padEnd(10)} via ${r.via || "?"}`);
}
