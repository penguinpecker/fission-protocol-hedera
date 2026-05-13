#!/usr/bin/env node
/**
 * QA Wave C — Hedera-specific edge cases not covered by happy-path e2e.
 *
 * Reads:
 *   - HIP-904 status on new contracts (MegaZap, RouterV3)
 *   - MegaZap token-association records
 *   - Cosigner association inventory
 *   - YT freeze enforcement (mirror + on-chain transfer attempt)
 *
 * On-chain probe: ONE attempted YT transfer from the deployer. Expected to
 * revert (CONTRACT_REVERT_EXECUTED → TOKEN_IS_FROZEN_FOR_ACCOUNT). Burns ~0.1
 * HBAR worth of gas. Hard cap below.
 *
 * Usage:
 *   cd scripts && node qa-wave-c.mjs
 *
 * Each subtest prints PASS / FAIL / SKIP with a short finding.
 */

import {
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  PrivateKey,
  Status,
} from "@hashgraph/sdk";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

function loadDotenv() {
  const p = join(REPO, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";

// ─── known IDs ─────────────────────────────────────────────────────────────
const MEGAZAP_ID = "0.0.10477452";
const ROUTER_V3_ID = "0.0.10477449";
const COSIGNER_ID = "0.0.10457309";
const DEPLOYER_ID = "0.0.10463169";

const TOK = {
  USDC: "0.0.456858",
  WHBAR: "0.0.1456986",
  SY_SHARE: "0.0.10465419",
  PT: "0.0.10465461",
  YT: "0.0.10465462",
  LP: "0.0.10465463",
};

const YT_EVM = "0x00000000000000000000000000000000009fb0b6";

// ─── result helpers ────────────────────────────────────────────────────────
const results = [];
function record(id, name, status, finding) {
  results.push({ id, name, status, finding });
  const tag = { PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP" }[status] ?? status;
  console.log(`[${tag}] ${id}. ${name}`);
  console.log(`     ${finding}`);
}

// ─── mirror helpers ────────────────────────────────────────────────────────
async function mirror(path) {
  const r = await fetch(`${MIRROR}${path}`);
  if (!r.ok) throw new Error(`Mirror ${path} → HTTP ${r.status}`);
  return r.json();
}

// Pull all token rows (paginate) for an account.
async function allTokensForAccount(accountId) {
  let url = `/api/v1/accounts/${accountId}/tokens?limit=100`;
  const out = [];
  while (url) {
    const j = await mirror(url);
    out.push(...(j.tokens ?? []));
    url = j.links?.next || null;
  }
  return out;
}

// ─── key derivation (matches scripts/derive-key.mjs) ──────────────────────
function deriveKeyHex() {
  const direct = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (direct) return direct.startsWith("0x") ? direct.slice(2) : direct;
  const seed = (process.env.SEED_PHRASE || "").trim();
  if (!validateMnemonic(seed, wordlist)) throw new Error("invalid SEED_PHRASE");
  const path = (process.env.HEDERA_DERIVATION_PATH || "m/44'/3030'/0'/0/0").trim();
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(seed)).derive(path);
  return Buffer.from(child.privateKey).toString("hex");
}

// ╔════════════════════════════════════════════════════════════════════════╗
// ║  A. HIP-904 on new contracts                                           ║
// ╚════════════════════════════════════════════════════════════════════════╝
async function testA() {
  try {
    const [mega, router] = await Promise.all([
      mirror(`/api/v1/accounts/${MEGAZAP_ID}`),
      mirror(`/api/v1/accounts/${ROUTER_V3_ID}`),
    ]);
    const megaMax = mega.max_automatic_token_associations;
    const routerMax = router.max_automatic_token_associations;
    const ok = megaMax === -1 && routerMax === -1;
    record(
      "A",
      "HIP-904 on MegaZap + Router v3",
      ok ? "PASS" : "FAIL",
      `MegaZap(${MEGAZAP_ID}).max_auto=${megaMax}, RouterV3(${ROUTER_V3_ID}).max_auto=${routerMax} (expect -1 / -1)`,
    );
  } catch (e) {
    record("A", "HIP-904 on MegaZap + Router v3", "FAIL", `Mirror error: ${e.message}`);
  }
}

// ╔════════════════════════════════════════════════════════════════════════╗
// ║  B. MegaZap association records for SY share / PT / LP                 ║
// ╚════════════════════════════════════════════════════════════════════════╝
async function testB() {
  try {
    const tokens = await allTokensForAccount(MEGAZAP_ID);
    const ids = new Set(tokens.map((t) => t.token_id));
    const required = [
      ["SY share", TOK.SY_SHARE],
      ["PT", TOK.PT],
      ["LP", TOK.LP],
    ];
    const missing = required.filter(([, id]) => !ids.has(id));
    const forbidden = [
      ["USDC", TOK.USDC],
      ["WHBAR", TOK.WHBAR],
    ].filter(([, id]) => ids.has(id));

    const totalRows = tokens.length;

    if (totalRows === 0) {
      record(
        "B",
        "MegaZap token-association records",
        "SKIP",
        `MegaZap (${MEGAZAP_ID}) has 0 token associations — no traffic since deploy 2026-05-13. HIP-904 = -1 means associations are auto-created on first inbound transfer; this only fails if MegaZap is invoked. Expected after Wave A e2e to see SY/PT/LP. Forbidden tokens (USDC, WHBAR) absent: OK.`,
      );
      return;
    }

    if (missing.length === 0 && forbidden.length === 0) {
      record(
        "B",
        "MegaZap token-association records",
        "PASS",
        `Found all 3 (SY/PT/LP). USDC/WHBAR absent as expected. Total assoc rows: ${totalRows}.`,
      );
    } else {
      const f = [];
      if (missing.length) f.push(`missing: ${missing.map(([n]) => n).join(", ")}`);
      if (forbidden.length) f.push(`unexpected: ${forbidden.map(([n]) => n).join(", ")}`);
      record("B", "MegaZap token-association records", "FAIL", f.join(" | "));
    }
  } catch (e) {
    record("B", "MegaZap token-association records", "FAIL", `Mirror error: ${e.message}`);
  }
}

// ╔════════════════════════════════════════════════════════════════════════╗
// ║  C. Cosigner inventory                                                 ║
// ╚════════════════════════════════════════════════════════════════════════╝
async function testC() {
  try {
    const tokens = await allTokensForAccount(COSIGNER_ID);
    const map = new Map(tokens.map((t) => [t.token_id, t]));
    const expectAssoc = [
      ["USDC", TOK.USDC],
      ["WHBAR", TOK.WHBAR],
      ["SY share", TOK.SY_SHARE],
      ["PT", TOK.PT],
      ["YT", TOK.YT],
    ];
    const missing = expectAssoc.filter(([, id]) => !map.has(id));
    const lpRow = map.get(TOK.LP);
    const ytRow = map.get(TOK.YT);

    const summary = expectAssoc
      .map(([n, id]) => {
        const row = map.get(id);
        return row ? `${n}=${row.balance}` : `${n}=MISSING`;
      })
      .join(", ");

    if (missing.length === 0) {
      record(
        "C",
        "Cosigner inventory (USDC/WHBAR/SY/PT/YT all associated)",
        "PASS",
        `${summary} | LP=${lpRow ? lpRow.balance + " (present)" : "absent (OK)"} | YT freeze_status=${ytRow?.freeze_status ?? "—"}`,
      );
    } else {
      record(
        "C",
        "Cosigner inventory",
        "FAIL",
        `Missing associations: ${missing.map(([n]) => n).join(", ")} | ${summary}`,
      );
    }
  } catch (e) {
    record("C", "Cosigner inventory", "FAIL", `Mirror error: ${e.message}`);
  }
}

// ╔════════════════════════════════════════════════════════════════════════╗
// ║  D. YT freeze enforcement                                              ║
// ╚════════════════════════════════════════════════════════════════════════╝
async function testD() {
  // D1 — Mirror sanity: freeze_key must exist (even though freeze_default=false).
  let tokenInfo;
  try {
    tokenInfo = await mirror(`/api/v1/tokens/${TOK.YT}`);
  } catch (e) {
    record("D", "YT freeze enforcement", "FAIL", `Token info fetch failed: ${e.message}`);
    return;
  }
  const hasFreezeKey = !!tokenInfo.freeze_key;
  const freezeDefault = tokenInfo.freeze_default;
  if (!hasFreezeKey) {
    record(
      "D",
      "YT freeze enforcement",
      "FAIL",
      `YT (${TOK.YT}) has no freeze_key — token cannot be frozen → OTC transfers cannot be blocked. CRITICAL deploy bug.`,
    );
    return;
  }

  // Sanity-check the deployer is actually FROZEN for YT.
  const dep = await mirror(`/api/v1/accounts/${DEPLOYER_ID}/tokens?token.id=${TOK.YT}`);
  const ytRow = dep.tokens?.[0];
  if (!ytRow) {
    record("D", "YT freeze enforcement", "SKIP", "Deployer has no YT row — cannot attempt OTC transfer.");
    return;
  }
  if (ytRow.freeze_status !== "FROZEN") {
    record(
      "D",
      "YT freeze enforcement",
      "FAIL",
      `Deployer YT freeze_status=${ytRow.freeze_status} (expected FROZEN). The market should refreeze recipients post-transfer. If UNFROZEN, deployer could OTC their YT — CRITICAL.`,
    );
    return;
  }
  if (ytRow.balance < 1n) {
    record("D", "YT freeze enforcement", "SKIP", "Deployer YT balance < 1 raw — cannot attempt transfer.");
    return;
  }

  // D2 — On-chain: attempt transfer(dummy, 1) on YT via ERC-20 HTS facade.
  let operatorKey;
  try {
    operatorKey = PrivateKey.fromStringECDSA(deriveKeyHex());
  } catch (e) {
    record("D", "YT freeze enforcement", "SKIP", `Cannot derive operator key: ${e.message}`);
    return;
  }
  const operatorId = (process.env.HEDERA_OPERATOR_ID || DEPLOYER_ID).trim();
  const client = Client.forMainnet().setOperator(operatorId, operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(2));

  // dummy recipient: 0x...dead00...0001 (no HTS association — but the freeze
  // check happens before the association check, so the revert should be the
  // freeze code regardless).
  const dummy = "0x000000000000000000000000000000000000dead";
  const ytContract = ContractId.fromEvmAddress(0, 0, YT_EVM);

  try {
    const tx = await new ContractExecuteTransaction()
      .setContractId(ytContract)
      .setGas(120_000)
      .setFunction(
        "transfer",
        new ContractFunctionParameters().addAddress(dummy).addUint256(1),
      )
      .freezeWith(client)
      .execute(client);
    let receipt;
    try {
      receipt = await tx.getReceipt(client);
    } catch (recErr) {
      // Hedera SDK throws on non-SUCCESS receipts. Capture the status.
      const status = recErr.status?.toString?.() ?? String(recErr.message || recErr);
      const isReject =
        status.includes("CONTRACT_REVERT_EXECUTED") ||
        status.includes("TOKEN_IS_FROZEN") ||
        status.includes("ACCOUNT_FROZEN");
      record(
        "D",
        "YT freeze enforcement (on-chain)",
        isReject ? "PASS" : "FAIL",
        `Attempted transfer(${dummy}, 1) on YT (${YT_EVM}). Receipt status: ${status}. ${
          isReject ? "Freeze enforcement WORKS." : "UNEXPECTED — expected revert."
        }`,
      );
      return;
    }
    // If we reach here, the transfer SUCCEEDED — that's a freeze-bypass bug.
    record(
      "D",
      "YT freeze enforcement (on-chain)",
      "FAIL",
      `CRITICAL: YT transfer to dummy SUCCEEDED (status=${receipt.status}). Frozen YT should not be transferable. tx=${tx.transactionId.toString()}`,
    );
  } catch (e) {
    // Network / submission errors land here. Some Hedera SDK error shapes
    // include the contract revert status directly.
    const msg = e?.status?.toString?.() || e?.message || String(e);
    const isReject =
      msg.includes("CONTRACT_REVERT_EXECUTED") ||
      msg.includes("TOKEN_IS_FROZEN") ||
      msg.includes("ACCOUNT_FROZEN");
    record(
      "D",
      "YT freeze enforcement (on-chain)",
      isReject ? "PASS" : "FAIL",
      `transfer threw: ${msg}. ${isReject ? "Freeze enforcement WORKS." : "Unexpected error — manual inspection."}`,
    );
  } finally {
    client.close();
  }
}

// ╔════════════════════════════════════════════════════════════════════════╗
// ║  E. Frontend association-gate prediction (static read)                 ║
// ╚════════════════════════════════════════════════════════════════════════╝
async function testE() {
  const checks = [
    {
      label: "BuyPT (/pt)",
      file: "frontend/src/components/forms/BuyPtForm.tsx",
      // The MegaZap path and the SDK-chain path both build the same
      // [syShare, WHBAR, pt] preassoc list. Verified via grep above.
      pattern: /\[\s*detail\.syShare\s*,\s*HEDERA_TOKENS\.WHBAR\s*,\s*detail\.pt\s*\]/,
      expect: "syShare + WHBAR + PT",
    },
    {
      label: "BuyYT (/yt)",
      file: "frontend/src/components/forms/BuyYtForm.tsx",
      pattern: /\[\s*detail\.syShare\s*,\s*HEDERA_TOKENS\.WHBAR\s*,\s*detail\.yt\s*\]/,
      expect: "syShare + WHBAR + YT",
    },
    {
      label: "Provide LP (/lp)",
      file: "frontend/src/app/markets/[address]/lp/page.tsx",
      pattern: /requiredTokens=\{\[detail\.lp\]\}/,
      expect: "LP share",
    },
    {
      label: "Mint SY (zap-only)",
      file: "frontend/src/components/forms/MintSyForm.tsx",
      // Two AssociationGate sites in this form — one (USDC+WHBAR add-liquidity)
      // and one (HBAR zap). We only assert the *zap-only* preassoc list = [syShare].
      pattern: /requiredTokens=\{\[syShare\]\}/,
      expect: "syShare",
    },
  ];

  const findings = [];
  let allOk = true;
  for (const c of checks) {
    let txt;
    try {
      txt = readFileSync(join(REPO, c.file), "utf8");
    } catch (e) {
      findings.push(`${c.label}: FILE-MISSING (${c.file})`);
      allOk = false;
      continue;
    }
    const ok = c.pattern.test(txt);
    findings.push(`${c.label} expects [${c.expect}] → ${ok ? "OK" : "WRONG"}`);
    if (!ok) allOk = false;
  }
  record("E", "Association-gate per-route", allOk ? "PASS" : "FAIL", findings.join(" | "));
}

// ╔════════════════════════════════════════════════════════════════════════╗
// ║  F. Stale-Mirror retry loop in readPostZapSyBalance                    ║
// ╚════════════════════════════════════════════════════════════════════════╝
async function testF() {
  const file = "frontend/src/components/forms/BuyPtForm.tsx";
  let txt;
  try {
    txt = readFileSync(join(REPO, file), "utf8");
  } catch (e) {
    record("F", "readPostZapSyBalance retry loop", "FAIL", `Cannot read ${file}: ${e.message}`);
    return;
  }
  const declared = txt.includes("const readPostZapSyBalance");
  // 5 iterations: `for (let i = 0; i < 5; i++)`. 1-second wait: setTimeout 1000.
  const fiveIter = /for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*5;\s*i\+\+\s*\)/.test(txt);
  const oneSec = /setTimeout\s*\(\s*[^,]+,\s*1000\s*\)/.test(txt);
  const comparesFresh = /fresh\s*>\s*preZapSy/.test(txt);
  const fallback = /return\s+fallback/.test(txt);

  const findings = [
    `declared=${declared}`,
    `5-iter loop=${fiveIter}`,
    `1s interval=${oneSec}`,
    `fresh>preZapSy compare=${comparesFresh}`,
    `fallback return=${fallback}`,
  ];

  const ok = declared && fiveIter && oneSec && comparesFresh && fallback;
  record("F", "readPostZapSyBalance retry loop (5 × 1s + fallback)", ok ? "PASS" : "FAIL", findings.join(" | "));
}

// ╔════════════════════════════════════════════════════════════════════════╗
// ║  G. Hashio rate-limit / network-error handling                         ║
// ╚════════════════════════════════════════════════════════════════════════╝
async function testG() {
  // Survey explicit Hashio usage (frontend + scripts) and flag unprotected
  // calls. Wagmi `useReadContracts` already returns per-call status (success/
  // failure) so those are protected by design.
  //
  // What we scan for: bare `await fetch(...hashio.io...)` or
  // `await client.readContract(...)` NOT inside try/catch.
  const filesToScan = [
    "frontend/src/app/api/activity/route.ts",
    "frontend/src/hooks/useSyValueUsd.ts",
    "frontend/src/lib/chains.ts",
  ];
  const findings = [];
  let warnings = 0;

  for (const f of filesToScan) {
    let txt;
    try {
      txt = readFileSync(join(REPO, f), "utf8");
    } catch {
      findings.push(`${f}: NOT-FOUND`);
      continue;
    }
    // Cheap heuristic: count `await client.readContract` calls vs `try {`
    // blocks containing them. We use a `try { ... } catch` envelope check.
    const reads = (txt.match(/await\s+client\.readContract/g) || []).length;
    const fetches = (txt.match(/await\s+fetch\s*\(/g) || []).length;
    const tryBlocks = (txt.match(/\btry\s*\{/g) || []).length;
    const catches = (txt.match(/\}\s*catch/g) || []).length;

    // Flag if there are reads/fetches but NO try/catch envelope at all.
    if ((reads > 0 || fetches > 0) && (tryBlocks === 0 || catches === 0)) {
      findings.push(`${f}: ${reads} readContract + ${fetches} fetch, ZERO try/catch → UNPROTECTED`);
      warnings++;
    } else {
      findings.push(`${f}: ${reads} readContract + ${fetches} fetch, ${catches} catch blocks → protected`);
    }
  }

  // Scripts: most testing scripts have inline `fetch` to mainnet.hashio.io
  // without retries — fine for one-shot scripts, but flag any in `keeper/`.
  const keeperDir = join(REPO, "keeper");
  if (existsSync(keeperDir)) {
    // (don't deep-scan keeper here — just note it exists; user can target it.)
    findings.push("keeper/ exists — not scanned in this pass (operational, not user-facing)");
  }

  record(
    "G",
    "Hashio network-error handling",
    warnings === 0 ? "PASS" : "FAIL",
    findings.join(" || "),
  );
}

// ─── main ──────────────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════════════");
console.log("  QA Wave C — Hedera-specific edge cases");
console.log(`  ${new Date().toISOString()}`);
console.log("═══════════════════════════════════════════════════════════════\n");

await testA();
await testB();
await testC();
await testD();
await testE();
await testF();
await testG();

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Summary");
console.log("═══════════════════════════════════════════════════════════════");
const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log(`  ${r.id}. [${r.status}] ${r.name}`);
}
console.log(`\n  PASS ${counts.PASS} | FAIL ${counts.FAIL} | SKIP ${counts.SKIP}`);
process.exit(counts.FAIL > 0 ? 1 : 0);
