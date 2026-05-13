#!/usr/bin/env node
// Prepare per-contract HashScan UI verification bundles.
//
// For each live contract in deployments/295.json, write:
//   audits/hashscan/<Name>/standard-input.json   <- paste into HashScan UI
//   audits/hashscan/<Name>/UPLOAD.md             <- step-by-step upload notes
//
// Why: HashScan's auto-verify (Sourcify) cannot reproduce Foundry's
// via_ir output bit-for-bit. The manual UI accepts the standard JSON
// input we generate here and matches against the deployed bytecode.
//
// Usage: node scripts/prep-hashscan-verify.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const DEPLOY = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));

// Map deployments/295.json keys → Foundry artifact path (relative to contracts/out).
// Only entries we actually want verified are included.
const TARGETS = [
  { name: "ActionRouter",            artifact: "ActionRouter.sol/ActionRouter.json",
    address: DEPLOY.router?.evm,                              live: true },
  { name: "FissionFactory",          artifact: "FissionFactory.sol/FissionFactory.json",
    address: DEPLOY.factory?.evm,                              live: true },
  { name: "StandardMarketDeployer",  artifact: "StandardMarketDeployer.sol/StandardMarketDeployer.json",
    address: DEPLOY.standard_deployer?.evm,                    live: true },
  { name: "RewardsMarketDeployer",   artifact: "RewardsMarketDeployer.sol/RewardsMarketDeployer.json",
    address: DEPLOY.rewards_deployer?.evm,                     live: true },
  { name: "SY_SaucerSwapV2LP",       artifact: "SY_SaucerSwapV2LP.sol/SY_SaucerSwapV2LP.json",
    address: DEPLOY.sy_saucer_v2_lp?.evm,                      live: true },
  { name: "FissionMarketRewards",    artifact: "FissionMarketRewards.sol/FissionMarketRewards.json",
    address: DEPLOY.markets?.[0]?.evm,                         live: true,
    note: "Market 0 is the only deployed FissionMarketRewards instance." },
  { name: "FissionZap",              artifact: "FissionZap.sol/FissionZap.json",
    address: DEPLOY.fission_zap?.evm,                          live: true,
    note: "Permissionless one-tx HBAR→SY zap. Redeployed 2026-05-13 (v2 msg.value-driven)." },
  // SY_HBARX entry is intentionally omitted: the live one predates 12 bug
  // fixes; it will be redeployed in Phase C and verified then.
];

const remappings = readFileSync(join(REPO, "contracts/remappings.txt"), "utf8")
  .split("\n").map(s => s.trim()).filter(Boolean)
  .map(r => { const [k, v] = r.split("="); return { from: k, to: v }; });

function resolveSource(srcPath) {
  const direct = join(REPO, "contracts", srcPath);
  if (existsSync(direct)) return direct;
  for (const { from, to } of remappings) {
    if (srcPath.startsWith(from)) {
      const rel = to + srcPath.slice(from.length);
      const cand = join(REPO, "contracts", rel);
      if (existsSync(cand)) return cand;
    }
  }
  return null;
}

function buildBundle(target) {
  const artifactPath = join(REPO, "contracts/out", target.artifact);
  if (!existsSync(artifactPath)) {
    return { ok: false, reason: `artifact missing: contracts/out/${target.artifact} (run \`forge build\` first)` };
  }
  const art = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (!art.rawMetadata) {
    return { ok: false, reason: "artifact has no rawMetadata (compile with metadata enabled)" };
  }
  const metadata = JSON.parse(art.rawMetadata);

  const sources = {};
  const unresolved = [];
  for (const [srcPath] of Object.entries(metadata.sources)) {
    const onDisk = resolveSource(srcPath);
    if (!onDisk) { unresolved.push(srcPath); continue; }
    sources[srcPath] = { content: readFileSync(onDisk, "utf8") };
  }
  if (unresolved.length) {
    return { ok: false, reason: `unresolved sources: ${unresolved.join(", ")}` };
  }

  const compilationTarget = metadata.settings.compilationTarget;
  const targetPath = Object.keys(compilationTarget)[0];
  const contractName = compilationTarget[targetPath];

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

  return {
    ok: true,
    stdInput,
    compilerVersion: `v${metadata.compiler.version}`,
    contractName,
    targetPath,
    runtimeBytecode: art.deployedBytecode?.object || null,
  };
}

const outDir = join(REPO, "audits/hashscan");
mkdirSync(outDir, { recursive: true });

const summary = [];
for (const t of TARGETS) {
  if (!t.address) {
    console.log(`[SKIP] ${t.name}: no address in deployments/295.json`);
    continue;
  }
  const bundle = buildBundle(t);
  if (!bundle.ok) {
    console.log(`[FAIL] ${t.name}: ${bundle.reason}`);
    summary.push({ name: t.name, address: t.address, ok: false, reason: bundle.reason });
    continue;
  }
  const dir = join(outDir, t.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "standard-input.json"),
    JSON.stringify(bundle.stdInput, null, 2),
  );
  const md = `# ${t.name} — HashScan UI verification

| Field | Value |
|-------|-------|
| Contract address (EVM) | \`${t.address}\` |
| Contract name          | \`${bundle.contractName}\` |
| Compiler               | Solidity \`${bundle.compilerVersion}\` |
| Optimizer              | enabled, runs = ${bundle.stdInput.settings.optimizer.runs} |
| EVM version            | \`${bundle.stdInput.settings.evmVersion}\` |
| viaIR                  | \`${bundle.stdInput.settings.viaIR}\` |
| Bytecode hash          | \`${bundle.stdInput.settings.metadata.bytecodeHash}\` |
| License                | MIT |
${t.note ? `| Note                   | ${t.note} |` : ""}

## Steps

1. Open HashScan: https://hashscan.io/mainnet/contract/${t.address}
2. Click **Verify** → choose **Standard JSON Input**.
3. Compiler version: \`${bundle.compilerVersion}\` (set the dropdown to match exactly).
4. Contract name: \`${bundle.contractName}\`.
5. **Upload** \`audits/hashscan/${t.name}/standard-input.json\` (this file's sibling).
6. Constructor args: see "Constructor args" below — paste hex (without 0x) if asked.
7. Submit. HashScan will recompile and match against deployed bytecode.

## Constructor args

Constructor args are NOT included in this bundle — HashScan auto-extracts them from the deployed bytecode tail. If the UI asks anyway, refer to:

- \`scripts/deploy-mainnet.mjs\` and \`scripts/deploy-mainnet-sdk.mjs\` for the constructor calls used.
- The transaction hash that created \`${t.address}\` (visible on HashScan) — its input data tail is the abi-encoded args.

## Reproducing locally

\`\`\`sh
cd contracts && forge build
\`\`\`

The artifact at \`contracts/out/${t.artifact}\` is what produced this bundle. The \`rawMetadata\` field there is the source-of-truth metadata; this bundle is a byte-stable derivation.
`;
  writeFileSync(join(dir, "UPLOAD.md"), md);
  console.log(`[OK]   ${t.name} -> audits/hashscan/${t.name}/`);
  summary.push({ name: t.name, address: t.address, ok: true,
                  size_kb: Math.round(JSON.stringify(bundle.stdInput).length / 1024) });
}

// Top-level index
const indexLines = [
  "# HashScan UI verification bundles",
  "",
  "Each subdirectory contains a `standard-input.json` you can upload to HashScan's manual UI verifier and an `UPLOAD.md` with per-contract steps.",
  "",
  "Why this exists: HashScan's auto-verify (Sourcify) can't reproduce Foundry's `via_ir` output bit-for-bit. Manual UI accepts the standard JSON we dump here.",
  "",
  "| Contract | Address | Bundle |",
  "|----------|---------|--------|",
];
for (const s of summary) {
  if (s.ok) indexLines.push(`| ${s.name} | \`${s.address}\` | [${s.name}/](${s.name}/UPLOAD.md) (${s.size_kb} KB JSON) |`);
  else      indexLines.push(`| ${s.name} | \`${s.address}\` | _failed: ${s.reason}_ |`);
}
indexLines.push("");
indexLines.push("Regenerate with: `node scripts/prep-hashscan-verify.mjs` after `forge build`.");
indexLines.push("");
writeFileSync(join(outDir, "README.md"), indexLines.join("\n"));
console.log(`\nIndex: audits/hashscan/README.md  (${summary.length} bundles)`);
