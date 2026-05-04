#!/usr/bin/env node
// Sourcify v1 multipart upload for HashScan's verifier
// (https://server-verify.hashscan.io). Bypasses `forge verify-contract`,
// which targets Sourcify v2 endpoints not exposed by the Hedera deployment.
//
// Reads the Foundry artifact for a given contract, extracts `rawMetadata`,
// and uploads metadata.json + every source file referenced by it.
//
// Usage:
//   node scripts/sourcify-verify.mjs <artifact-path> <evm-address>
//   e.g. node scripts/sourcify-verify.mjs ActionRouter.sol/ActionRouter.json 0x...009fad96

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const SOURCIFY_URL = process.env.SOURCIFY_URL || "https://server-verify.hashscan.io";
const CHAIN_ID = process.env.CHAIN_ID || "295";

const [artifactArg, address] = process.argv.slice(2);
if (!artifactArg || !address?.startsWith("0x")) {
  console.error("Usage: node scripts/sourcify-verify.mjs <artifact-relative-path> <evm-address>");
  process.exit(1);
}

const artifactPath = join(REPO, "contracts/out", artifactArg);
if (!existsSync(artifactPath)) {
  console.error(`artifact not found: ${artifactPath}`);
  process.exit(1);
}

const art = JSON.parse(readFileSync(artifactPath, "utf8"));
const rawMetadata = art.rawMetadata;
if (!rawMetadata) {
  console.error(`no rawMetadata in artifact (rebuild contracts with metadata enabled?)`);
  process.exit(1);
}
const metadata = JSON.parse(rawMetadata);

// Sourcify needs every source file the metadata references. Foundry's metadata
// holds a `sources` map keyed by the path the compiler saw (which honors
// remappings). We need to find each on disk.
const remappings = readFileSync(join(REPO, "contracts/remappings.txt"), "utf8")
  .split("\n").map(s => s.trim()).filter(Boolean)
  .map(r => { const [k, v] = r.split("="); return { from: k, to: v }; });

function resolveSource(srcPath) {
  // Try direct under contracts/
  const direct = join(REPO, "contracts", srcPath);
  if (existsSync(direct)) return direct;
  // Apply remappings
  for (const { from, to } of remappings) {
    if (srcPath.startsWith(from)) {
      const rel = to + srcPath.slice(from.length);
      const cand = join(REPO, "contracts", rel);
      if (existsSync(cand)) return cand;
    }
  }
  return null;
}

// Build Sourcify's solc-json verify payload. The JSON variant keeps the source
// paths intact (form-data strips them), so solc can resolve relative imports.
const sources = {};
let missing = 0;
for (const [srcPath] of Object.entries(metadata.sources)) {
  const onDisk = resolveSource(srcPath);
  if (!onDisk) {
    console.warn(`  ! could not resolve source: ${srcPath}`);
    missing++;
    continue;
  }
  sources[srcPath] = { content: readFileSync(onDisk, "utf8") };
}
if (missing > 0) {
  console.error(`${missing} source files unresolved — verification likely to fail.`);
}

// Sourcify's solc-json endpoint expects a `files` map where each value is a
// "standard JSON input" doc. We need to determine compilerVersion + contractName.
const compilerVersion = `v${metadata.compiler.version}`;

// contractName is just the bare contract name; targetPath identifies its file.
const target = metadata.settings.compilationTarget;
const targetPath = Object.keys(target)[0];
const contractName = target[targetPath];

const stdInput = {
  language: metadata.language,
  sources,
  settings: {
    optimizer: metadata.settings.optimizer,
    evmVersion: metadata.settings.evmVersion,
    libraries: metadata.settings.libraries || {},
    metadata: { bytecodeHash: metadata.settings.metadata?.bytecodeHash || "none" },
    remappings: metadata.settings.remappings || [],
    viaIR: metadata.settings.viaIR ?? false,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } },
  },
};

const payload = {
  address,
  chain: CHAIN_ID,
  compilerVersion,
  contractName,
  files: { "input.json": JSON.stringify(stdInput) },
};

console.log(`POST ${SOURCIFY_URL}/verify/solc-json  (compiler=${compilerVersion}, name=${contractName})`);
const res = await fetch(`${SOURCIFY_URL}/verify/solc-json`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const body = await res.text();
console.log(`HTTP ${res.status}`);
try {
  const j = JSON.parse(body);
  console.log(JSON.stringify(j, null, 2).slice(0, 2000));
} catch {
  console.log(body.slice(0, 2000));
}
