#!/usr/bin/env node
// Generate a Safe Tx Builder JSON for transferring DEFAULT_ADMIN_ROLE
// from the deployer EOA to the production 2-of-2 Safe, plus revoking
// every secondary role (ADMIN_ROLE, PAUSER_ROLE) the deployer holds.
//
// Workflow:
//   1. Read deployments/295.json + the production-factory addresses
//      (set CUTOVER=1 to use the prod factory + new SY_HBARX, otherwise
//      the bootstrap factory is the source of truth).
//   2. Emit two artifact files under deployments/safe-handoff/:
//        - deployer-side.json  : transactions the DEPLOYER EOA must send
//                                (begin admin transfers via cast send / SDK)
//        - safe-side.json      : Safe Tx Builder import (paste in
//                                https://app.safe.global → Tx Builder)
//      The Safe-side file is the one a 2-of-2 multisig signs/executes.
//
// Usage:
//   PROD_SAFE=0x...  PROD_FACTORY=0x...  PROD_SY_HBARX=0x...  \
//   node scripts/prep-safe-handoff.mjs
//
// All address env vars are required for the production cutover. For a
// dry run against the bootstrap factory + existing SY_HBARX, set
// DRY_RUN=1 and the script will use deployments/295.json values.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const DEPLOY = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));

const dry = process.env.DRY_RUN === "1";

const SAFE        = process.env.PROD_SAFE        || (dry ? DEPLOY.deployerEvm   : null);
const FACTORY     = process.env.PROD_FACTORY     || DEPLOY.factory.evm;
const SY_HBARX    = process.env.PROD_SY_HBARX    || DEPLOY.sy_hbarx.evm;
const SY_SAUCER   = DEPLOY.sy_saucer_v2_lp.evm;
const ROUTER      = DEPLOY.router.evm;
const MARKET_RWD  = DEPLOY.markets?.[0]?.evm; // FissionMarketRewards
const DEPLOYER    = DEPLOY.deployerEvm;

if (!SAFE) {
  console.error("Set PROD_SAFE=0x... (the 2-of-2 Safe address) or DRY_RUN=1 to test.");
  process.exit(1);
}

// --- Role hashes (keccak256 of role name) ---------------------------------
const enc = (s) => new TextEncoder().encode(s);
const roleHash = (name) => name === ""
  ? "0x0000000000000000000000000000000000000000000000000000000000000000"
  : "0x" + Buffer.from(keccak_256(enc(name))).toString("hex");

const ROLES = {
  DEFAULT_ADMIN_ROLE: roleHash(""),                       // 0x0000…
  ADMIN_ROLE:         roleHash("ADMIN_ROLE"),
  PAUSER_ROLE:        roleHash("PAUSER_ROLE"),
  KEEPER_ROLE:        roleHash("KEEPER_ROLE"),
};

// --- 4byte selectors via keccak -------------------------------------------
const sel = (sig) => "0x" + Buffer.from(keccak_256(enc(sig))).toString("hex").slice(0, 8);
const SEL = {
  beginDefaultAdminTransfer:  sel("beginDefaultAdminTransfer(address)"),
  acceptDefaultAdminTransfer: sel("acceptDefaultAdminTransfer()"),
  revokeRole:                 sel("revokeRole(bytes32,address)"),
  grantRole:                  sel("grantRole(bytes32,address)"),
};

const padAddr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padHex  = (h) => h.toLowerCase().replace(/^0x/, "").padStart(64, "0");

// --- Build the deployer-side calls (begin admin transfer + grant Safe) -----
const adminContracts = [
  { name: "FissionFactory",        addr: FACTORY,    secondaryRoles: ["ADMIN_ROLE"] },
  { name: "SY_HBARX",              addr: SY_HBARX,   secondaryRoles: ["ADMIN_ROLE", "PAUSER_ROLE", "KEEPER_ROLE"] },
  { name: "SY_SaucerSwapV2LP",     addr: SY_SAUCER,  secondaryRoles: ["ADMIN_ROLE", "PAUSER_ROLE"] },
  { name: "FissionMarketRewards",  addr: MARKET_RWD, secondaryRoles: ["ADMIN_ROLE", "PAUSER_ROLE"] },
  // ActionRouter is UUPS-upgradeable; ownership transfer follows the same shape.
  // Add additional FissionMarket entries here once the prod-cutover createMarket
  // calls land (HBARX-90D, etc.).
].filter(c => !!c.addr);

const deployerCalls = adminContracts.map(c => ({
  contract: c.name,
  to: c.addr,
  description: `${c.name}: deployer begins DEFAULT_ADMIN_ROLE transfer to Safe ${SAFE}`,
  data: SEL.beginDefaultAdminTransfer + padAddr(SAFE),
}));

// --- Build the Safe-side Tx Builder import --------------------------------
// One transaction batch:
//   1. accept default admin on every contract
//   2. revoke deployer from every secondary role
const safeTxs = [];
for (const c of adminContracts) {
  safeTxs.push({
    to: c.addr,
    value: "0",
    data: SEL.acceptDefaultAdminTransfer,
    contractMethod: { name: "acceptDefaultAdminTransfer", payable: false, inputs: [] },
    contractInputsValues: {},
  });
  for (const r of c.secondaryRoles) {
    safeTxs.push({
      to: c.addr,
      value: "0",
      data: SEL.revokeRole + padHex(ROLES[r]) + padAddr(DEPLOYER),
      contractMethod: {
        name: "revokeRole", payable: false,
        inputs: [
          { internalType: "bytes32", name: "role",    type: "bytes32" },
          { internalType: "address", name: "account", type: "address" },
        ],
      },
      contractInputsValues: { role: ROLES[r], account: DEPLOYER },
    });
  }
}

// Tx Builder import schema:
const txBuilderJson = {
  version: "1.0",
  chainId: "295",
  createdAt: Date.now(),
  meta: {
    name: `Fission Protocol — admin handoff to ${SAFE}`,
    description: "Accept DEFAULT_ADMIN_ROLE on every protocol contract, then revoke every secondary role from the deployer EOA.",
    txBuilderVersion: "1.16.5",
    createdFromSafeAddress: SAFE,
    createdFromOwnerAddress: "",
    checksum: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  transactions: safeTxs,
};

// --- Write artifacts -------------------------------------------------------
const outDir = join(REPO, "deployments/safe-handoff");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "deployer-side.json"),
  JSON.stringify({ chainId: 295, safe: SAFE, deployer: DEPLOYER, calls: deployerCalls }, null, 2),
);
writeFileSync(
  join(outDir, "safe-side.json"),
  JSON.stringify(txBuilderJson, null, 2),
);

// --- Plain-text runbook ----------------------------------------------------
const runbook = `# Safe handoff runbook (2-of-2 cutover)

Target Safe: \`${SAFE}\`
Deployer EOA: \`${DEPLOYER}\`
Network: Hedera mainnet (chain 295)

Two artifacts produced:
- \`deployer-side.json\` — transactions the DEPLOYER EOA broadcasts (one per contract).
- \`safe-side.json\` — paste into https://app.safe.global → Apps → Transaction Builder → "Load JSON".

## Step 1 — DEPLOYER side (one tx per contract)

Each call uses the \`beginDefaultAdminTransfer(address)\` selector. Constructor-time
\`adminTransferDelay = 0\` means the Safe can accept immediately.

| Contract | Address | Calldata |
|----------|---------|----------|
${deployerCalls.map(c => `| ${c.contract} | \`${c.to}\` | \`${c.data}\` |`).join("\n")}

Sign + broadcast each from the deployer key (any of: \`cast send\`, the Hedera SDK
\`ContractExecuteTransaction\`, or HashPack with raw-transaction support).

## Step 2 — SAFE side (single batched tx via Tx Builder)

1. Open the Safe at https://app.safe.global, switch to chain 295.
2. Apps → Transaction Builder → "Load JSON" → upload \`safe-side.json\`.
3. Review: ${safeTxs.length} transactions total —
   ${adminContracts.length} \`acceptDefaultAdminTransfer()\` calls plus
   ${safeTxs.length - adminContracts.length} \`revokeRole(...)\` calls.
4. Both 2-of-2 owners sign. Execute.

## Step 3 — Verify

For each contract, run:
\`\`\`sh
cast call <addr> "hasRole(bytes32,address)(bool)" 0x0000...0000 ${DEPLOYER} --rpc-url $HEDERA_MAINNET_RPC
# expected: false
cast call <addr> "hasRole(bytes32,address)(bool)" 0x0000...0000 ${SAFE} --rpc-url $HEDERA_MAINNET_RPC
# expected: true
\`\`\`

Update \`deployments/295.json\` with the post-handoff role state.
`;

writeFileSync(join(outDir, "RUNBOOK.md"), runbook);

console.log(`Wrote:`);
console.log(`  deployments/safe-handoff/deployer-side.json   (${deployerCalls.length} deployer calls)`);
console.log(`  deployments/safe-handoff/safe-side.json       (${safeTxs.length} Safe txs)`);
console.log(`  deployments/safe-handoff/RUNBOOK.md`);
console.log(``);
console.log(`Safe: ${SAFE}`);
console.log(`Contracts in scope:`);
adminContracts.forEach(c => console.log(`  ${c.name.padEnd(24)} ${c.addr}   roles: DEFAULT_ADMIN + [${c.secondaryRoles.join(", ")}]`));
