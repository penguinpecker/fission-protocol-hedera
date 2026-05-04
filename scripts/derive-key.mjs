#!/usr/bin/env node
// Derive an ECDSA EVM private key from a BIP-39 seed phrase, at the Hedera
// derivation path (m/44'/3030'/0'/0/0 by default). Prints the key as
// `0x<64-hex-chars>` to stdout — nothing else, so the caller can capture it.
//
// Reads from .env at repo root (or process.env if already exported):
//   SEED_PHRASE             — required (12 or 24 words, space-separated)
//   HEDERA_DERIVATION_PATH  — optional (default m/44'/3030'/0'/0/0)
//
// Usage:
//   export HEDERA_OPERATOR_KEY="$(node scripts/derive-key.mjs)"

import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Inline dotenv loader (handles seeds with spaces / apostrophes that break
//    naive `set -a; source .env; set +a` shells). ──
function loadDotenv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}
loadDotenv();

const seedPhrase = (process.env.SEED_PHRASE ?? "").trim();
if (!seedPhrase) {
  console.error("ERROR: SEED_PHRASE is empty. Set it in .env or export it before running.");
  process.exit(1);
}

if (!validateMnemonic(seedPhrase, wordlist)) {
  console.error("ERROR: SEED_PHRASE is not a valid BIP-39 mnemonic.");
  process.exit(1);
}

const path = (process.env.HEDERA_DERIVATION_PATH ?? "m/44'/3030'/0'/0/0").trim();
const seed = mnemonicToSeedSync(seedPhrase);
const child = HDKey.fromMasterSeed(seed).derive(path);
if (!child.privateKey) {
  console.error(`ERROR: derivation at path '${path}' produced no private key.`);
  process.exit(1);
}

process.stdout.write("0x" + Buffer.from(child.privateKey).toString("hex"));
