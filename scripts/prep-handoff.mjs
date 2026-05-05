#!/usr/bin/env node
// Generate Hedera-native admin-handoff artifacts for the v1 cutover.
//
// Architecture (Hedera-native; no Gnosis Safe contract):
//
//   2-of-2 ThresholdKey account
//          │  signs Hedera ContractExecuteTransaction →
//          ▼
//      TimelockController (OZ, 48h delay) — DEFAULT_ADMIN_ROLE on every contract
//          │  Timelock.execute() then calls into the protocol
//          ▼
//      FissionFactory / SY_HBARX / SY_SaucerSwapV2LP / Markets…
//
// What this script outputs (under deployments/handoff/):
//
//   1) deployer-side.json       — txs the DEPLOYER EOA broadcasts. One
//      `beginDefaultAdminTransfer(timelock)` per protocol contract. Plain
//      EVM calldata; sign with operator key via cast / SDK / HashPack.
//
//   2) timelock-batch.json      — the OZ Timelock `scheduleBatch(targets,
//      values, payloads, predecessor, salt, delay)` payload. The threshold
//      account signs ContractExecuteTransaction with this calldata. Every
//      `acceptDefaultAdminTransfer()` AND every `revokeRole(role, deployer)`
//      goes through this single batched call.
//
//   3) RUNBOOK.md               — human-readable step-by-step (cast snippets,
//      verify queries, expected outcomes).
//
// Usage:
//   PROD_THRESHOLD_EVM=0x...  PROD_TIMELOCK=0x...  node scripts/prep-handoff.mjs
//
//   For a dry run pre-deploy:
//     DRY_RUN=1 node scripts/prep-handoff.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const DEPLOY = JSON.parse(readFileSync(join(REPO, "deployments/295.json"), "utf8"));

const dry = process.env.DRY_RUN === "1";

const THRESHOLD = process.env.PROD_THRESHOLD_EVM
  || (dry ? "0x000000000000000000000000000000000000dEaD" : null);
const TIMELOCK  = process.env.PROD_TIMELOCK
  || (dry ? "0x000000000000000000000000000000000000bEEf" : null);
const FACTORY   = process.env.PROD_FACTORY    || DEPLOY.factory.evm;
const SY_HBARX  = process.env.PROD_SY_HBARX   || DEPLOY.sy_hbarx.evm;
const SY_SAUCER = DEPLOY.sy_saucer_v2_lp.evm;
const MARKET_RWD = DEPLOY.markets?.[0]?.evm;
const DEPLOYER  = DEPLOY.deployerEvm;

if (!THRESHOLD || !TIMELOCK) {
  console.error("Set PROD_THRESHOLD_EVM=0x... and PROD_TIMELOCK=0x... (or DRY_RUN=1).");
  process.exit(1);
}

// ---------- selectors + role hashes (4byte) ----------
const enc = (s) => new TextEncoder().encode(s);
const roleHash = (n) => n === ""
  ? "0x0000000000000000000000000000000000000000000000000000000000000000"
  : "0x" + Buffer.from(keccak_256(enc(n))).toString("hex");
const sel = (sig) => "0x" + Buffer.from(keccak_256(enc(sig))).toString("hex").slice(0, 8);

const ROLES = {
  DEFAULT_ADMIN_ROLE: roleHash(""),
  ADMIN_ROLE:         roleHash("ADMIN_ROLE"),
  PAUSER_ROLE:        roleHash("PAUSER_ROLE"),
  KEEPER_ROLE:        roleHash("KEEPER_ROLE"),
};

const SEL = {
  beginDefaultAdminTransfer:  sel("beginDefaultAdminTransfer(address)"),
  acceptDefaultAdminTransfer: sel("acceptDefaultAdminTransfer()"),
  revokeRole:                 sel("revokeRole(bytes32,address)"),
  scheduleBatch:              sel("scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)"),
  executeBatch:               sel("executeBatch(address[],uint256[],bytes[],bytes32,bytes32)"),
};

const padAddr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padHex  = (h) => h.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padU256 = (n) => BigInt(n).toString(16).padStart(64, "0");

// Manual ABI encoding of `(address[], uint256[], bytes[], bytes32, bytes32, uint256)`
// — three dynamic arrays + 3 static. No viem/ethers dep — keeps script light.
function encodeBatchArgs(targets, values, payloads, predecessor, salt, delayOrNull) {
  const staticCount = delayOrNull === null ? 5 : 6;
  let head = "";
  let tail = "";
  let cursor = staticCount * 32;

  // targets[]
  head += padU256(cursor);
  let arr = padU256(targets.length);
  for (const t of targets) arr += padAddr(t);
  tail += arr;
  cursor += arr.length / 2;

  // values[]
  head += padU256(cursor);
  arr = padU256(values.length);
  for (const v of values) arr += padU256(v);
  tail += arr;
  cursor += arr.length / 2;

  // payloads[] (bytes[])
  head += padU256(cursor);
  arr = padU256(payloads.length);
  let pCursor = payloads.length * 32;
  let offs = "";
  let bodies = "";
  for (const p of payloads) {
    offs += padU256(pCursor);
    const stripped = p.replace(/^0x/, "");
    const lenWords = Math.ceil(stripped.length / 64);
    const padded = stripped.padEnd(lenWords * 64, "0");
    bodies += padU256(stripped.length / 2) + padded;
    pCursor += 32 + padded.length / 2;
  }
  arr += offs + bodies;
  tail += arr;
  cursor += arr.length / 2;

  head += padHex(predecessor);
  head += padHex(salt);
  if (delayOrNull !== null) head += padU256(delayOrNull);

  return "0x" + head + tail;
}

// ---------- which contracts get handed off ----------
const adminContracts = [
  { name: "FissionFactory",       addr: FACTORY,    secondaryRoles: ["ADMIN_ROLE"] },
  { name: "SY_HBARX",             addr: SY_HBARX,   secondaryRoles: ["ADMIN_ROLE", "PAUSER_ROLE", "KEEPER_ROLE"] },
  { name: "SY_SaucerSwapV2LP",    addr: SY_SAUCER,  secondaryRoles: ["ADMIN_ROLE", "PAUSER_ROLE"] },
  { name: "FissionMarketRewards", addr: MARKET_RWD, secondaryRoles: ["ADMIN_ROLE", "PAUSER_ROLE"] },
].filter(c => !!c.addr);

// ---------- (1) deployer-side: begin admin transfers ----------
const deployerCalls = adminContracts.map(c => ({
  contract: c.name,
  to: c.addr,
  description: `Deployer begins DEFAULT_ADMIN_ROLE transfer to Timelock ${TIMELOCK}`,
  data: SEL.beginDefaultAdminTransfer + padAddr(TIMELOCK),
  expectedSender: DEPLOYER,
}));

// ---------- (2) Timelock batch: accept admin + revoke deployer roles ----------
const targets = [];
const values  = [];
const payloads = [];

for (const c of adminContracts) {
  targets.push(c.addr);
  values.push("0");
  payloads.push(SEL.acceptDefaultAdminTransfer);

  for (const r of c.secondaryRoles) {
    targets.push(c.addr);
    values.push("0");
    payloads.push(SEL.revokeRole + padHex(ROLES[r]) + padAddr(DEPLOYER));
  }
}

const PREDECESSOR = "0x0000000000000000000000000000000000000000000000000000000000000000";
const SALT        = "0x" + Buffer.from(keccak_256(enc("fission-handoff-v1"))).toString("hex");
const DELAY       = process.env.HANDOFF_DELAY_SECONDS || "0";  // 0 for first cutover

const scheduleCalldata = SEL.scheduleBatch
  + encodeBatchArgs(targets, values, payloads, PREDECESSOR, SALT, DELAY).slice(2);
const executeCalldata  = SEL.executeBatch
  + encodeBatchArgs(targets, values, payloads, PREDECESSOR, SALT, null).slice(2);

// ---------- write artifacts ----------
const outDir = join(REPO, "deployments/handoff");
mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, "deployer-side.json"),
  JSON.stringify({
    chainId: 295,
    deployer: DEPLOYER,
    timelock: TIMELOCK,
    threshold: THRESHOLD,
    calls: deployerCalls,
  }, null, 2),
);

writeFileSync(
  join(outDir, "timelock-batch.json"),
  JSON.stringify({
    chainId: 295,
    threshold: THRESHOLD,
    timelock: TIMELOCK,
    delaySeconds: Number(DELAY),
    operationCount: targets.length,
    schedule: { to: TIMELOCK, value: "0", data: scheduleCalldata },
    execute:  { to: TIMELOCK, value: "0", data: executeCalldata  },
    operations: targets.map((t, i) => ({ target: t, value: values[i], payload: payloads[i] })),
    predecessor: PREDECESSOR,
    salt: SALT,
  }, null, 2),
);

const runbook = `# Hedera-native admin handoff — runbook

Threshold account: \`${THRESHOLD}\` (Hedera 2-of-2 ThresholdKey, EVM alias)
Timelock contract: \`${TIMELOCK}\`
Deployer EOA:     \`${DEPLOYER}\`
Network:          Hedera mainnet (chain 295)
Min delay:        ${DELAY}s${DELAY === "0" ? "  (first cutover; raise to 48h via Timelock self-call after handoff)" : ""}

## Step 1 — DEPLOYER side (one tx per contract)

Deployer EOA initiates the DEFAULT_ADMIN_ROLE transfer for each contract.
Per OZ \`AccessControlDefaultAdminRules\`, only the current admin can call
\`beginDefaultAdminTransfer\`.

| Contract | Address | Calldata |
|----------|---------|----------|
${deployerCalls.map(c => `| ${c.contract} | \`${c.to}\` | \`${c.data}\` |`).join("\n")}

Sign and broadcast each (cast / SDK / HashPack):

\`\`\`sh
cast send <addr> "beginDefaultAdminTransfer(address)" ${TIMELOCK} \\
    --rpc-url $HEDERA_MAINNET_RPC --private-key $DEPLOYER_KEY
# repeat for each contract above
\`\`\`

## Step 2 — Threshold account schedules the Timelock batch

The 2-of-2 Hedera ThresholdKey account broadcasts a single Hedera
\`ContractExecuteTransaction\` calling \`Timelock.scheduleBatch(...)\`. Both
co-signers sign the Hedera tx (the consensus layer enforces 2-of-2; on
the EVM side the threshold account is just one address).

Target:     \`${TIMELOCK}\`
Value:      0 HBAR
Calldata:   _(see \`timelock-batch.json\` → schedule.data)_
Operations: ${targets.length} (${adminContracts.length} accept + ${targets.length - adminContracts.length} revoke)

## Step 3 — wait \`minDelay\`

If \`HANDOFF_DELAY_SECONDS=0\` (first cutover), proceed immediately.
Otherwise wait the full delay (e.g. 172800s = 48h).

## Step 4 — Threshold account executes the batch

Threshold account broadcasts \`Timelock.executeBatch(...)\` with the same
\`(targets, values, payloads, predecessor, salt)\` tuple.

## Step 5 — Verify

For every contract:

\`\`\`sh
cast call <addr> "hasRole(bytes32,address)(bool)" \\
    0x0000...0000 ${DEPLOYER} --rpc-url $HEDERA_MAINNET_RPC
# expected: false
cast call <addr> "hasRole(bytes32,address)(bool)" \\
    0x0000...0000 ${TIMELOCK} --rpc-url $HEDERA_MAINNET_RPC
# expected: true
\`\`\`

## Step 6 — raise Timelock delay to 48h (if step 3 used delay=0)

Schedule + execute from the threshold account:
\`\`\`
target: ${TIMELOCK}
data:   updateDelay(172800)
\`\`\`
`;

writeFileSync(join(outDir, "RUNBOOK.md"), runbook);

console.log("Wrote:");
console.log(`  deployments/handoff/deployer-side.json   (${deployerCalls.length} deployer calls)`);
console.log(`  deployments/handoff/timelock-batch.json  (${targets.length} batched operations)`);
console.log(`  deployments/handoff/RUNBOOK.md`);
console.log("");
console.log(`Threshold account: ${THRESHOLD}`);
console.log(`Timelock:          ${TIMELOCK}`);
adminContracts.forEach(c => console.log(`  ${c.name.padEnd(24)} ${c.addr}   roles: DEFAULT_ADMIN + [${c.secondaryRoles.join(", ")}]`));
