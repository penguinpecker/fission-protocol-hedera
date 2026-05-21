#!/usr/bin/env node
// Sourcify multipart-upload variant — uploads metadata.json + every referenced
// source as separate file entries. This is the variant the HashScan Sourcify
// server expects (the prior `solc-json` path's "1 files" error came from sending
// only standard-input JSON; Sourcify wanted metadata.json + sources side-by-side).
//
// Usage: node scripts/sourcify-verify-v2.mjs <artifact-relative-path> <evm-address>

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const SOURCIFY_URL = process.env.SOURCIFY_URL || "https://server-verify.hashscan.io";
const CHAIN_ID = process.env.CHAIN_ID || "295";

const [artifactArg, address] = process.argv.slice(2);
if (!artifactArg || !address?.startsWith("0x")) {
  console.error("Usage: node scripts/sourcify-verify-v2.mjs <artifact-relative-path> <evm-address>");
  process.exit(1);
}

const artifactPath = join(REPO, "contracts/out", artifactArg);
const art = JSON.parse(readFileSync(artifactPath, "utf8"));
const rawMetadata = art.rawMetadata;
if (!rawMetadata) { console.error("no rawMetadata"); process.exit(1); }
const metadata = JSON.parse(rawMetadata);

// Resolve every source file the metadata references
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

const formData = new FormData();
formData.append("address", address);
formData.append("chain", CHAIN_ID);

// metadata.json — Sourcify keys off this
formData.append("files", new Blob([rawMetadata], { type: "application/json" }), "metadata.json");

let missing = 0;
for (const srcPath of Object.keys(metadata.sources)) {
  const onDisk = resolveSource(srcPath);
  if (!onDisk) { console.warn(`  ! missing source: ${srcPath}`); missing++; continue; }
  const content = readFileSync(onDisk, "utf8");
  // Preserve the original path so Sourcify can match it to metadata.sources
  formData.append("files", new Blob([content], { type: "text/plain" }), srcPath);
}
if (missing > 0) console.warn(`  ${missing} sources missing — likely verify failure`);

console.log(`POST ${SOURCIFY_URL}/verify  (multipart, ${Object.keys(metadata.sources).length} sources + metadata)`);
const res = await fetch(`${SOURCIFY_URL}/verify`, { method: "POST", body: formData });
const body = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 2000));
} catch {
  console.log(body.slice(0, 2000));
}
