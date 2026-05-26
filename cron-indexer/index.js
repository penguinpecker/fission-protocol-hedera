#!/usr/bin/env node
// Fission indexer. Polls Hedera Mirror Node for recent contract calls on
// every Fission contract (live + abandoned-but-still-on-chain), decodes the
// function selector to a canonical event_type, and upserts each unique
// (chain_id, tx_hash, event_type, address) into Supabase `activity_log`.
// Idempotent on the composite key.
//
// 2026-05-25 rewrite: watch list is sourced from ../deployments/295.json so
// the indexer never drifts from the deployed truth. New contracts (factory,
// markets, FissionUnzap, lens, deployers) are picked up automatically on
// restart. Abandoned contracts remain in the list so historical positions
// keep indexing (still-redeemable on-chain).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 60_000);
const PER_CONTRACT_LIMIT = Number(process.env.PER_CONTRACT_LIMIT ?? 50);
const CHAIN_ID = 295;
const MIRROR = "https://mainnet-public.mirrornode.hedera.com/api/v1";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env");
  process.exit(1);
}

// ─── Watch list, sourced from deployments JSON ──────────────────────────────

// Resolve deployments/295.json. Railway builds with cron-indexer/ as the
// build context, so the parent repo's deployments/ directory is NOT shipped
// — we keep an in-tree copy at cron-indexer/deployments/295.json. Local dev
// can still point at the canonical file via DEPLOYMENTS_PATH or the
// auto-detected sibling-dir path. Keep the two copies in sync (CI / pre-commit
// or just re-run the deploy step).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = SCRIPT_DIR.replace(/\/cron-indexer$/, "");
const LOCAL_BUNDLED = join(SCRIPT_DIR, "deployments", "295.json");
const PARENT_REPO = join(REPO_ROOT, "deployments", "295.json");
const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH
  ?? (existsSync(LOCAL_BUNDLED) ? LOCAL_BUNDLED : PARENT_REPO);

function loadContractsFromDeployments() {
  const d = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8"));
  const list = [];
  const push = (evm, name, market = false) => {
    if (!evm || evm === "(reused)" || typeof evm !== "string" || !evm.startsWith("0x")) return;
    list.push({ evm: evm.toLowerCase(), name, market });
  };

  // Live core (2026-05-27 clean-slate redeploy)
  push(d.factory?.evm, "Factory");
  push(d.periphery?.evm, "FissionPeriphery");
  push(d.lens?.evm ?? d.lens?.evm_address, "Lens");
  push(d.standard_deployer?.evm, "StandardDeployer");
  push(d.rewards_deployer?.evm, "RewardsDeployer");
  push(d.sy_hbarx?.evm, "SY_HBARX");
  push(d.sy_saucer_v2_lp?.evm, "SY_SaucerSwapV2LP");
  // Pre-rebuild legacy (if still in the file)
  push(d.router?.evm, "ActionRouter");
  push(d.router_v3?.evm, "ActionRouterV3");
  push(d.fission_zap?.evm, "FissionZap");
  push(d.mega_zap?.evm, "MegaZap");
  push(d.fission_unzap?.evm, "FissionUnzap");
  push(d.fission_gateway?.evm, "FissionGateway");

  // Live markets — `market: true` so activity_log gets the market addr,
  // not the contract itself, as the grouping key.
  for (const m of d.markets ?? []) push(m.evm, `Market_${m.suffix ?? m.id}`, true);

  // Abandoned-but-still-on-chain. Users with positions there can still
  // redeem/withdraw, so we keep indexing them. Marked with `archived:true`
  // (just a label — does not affect indexing semantics).
  for (const evm of d.abandoned?.old_factories ?? []) push(evm, "Factory_archived");
  for (const evm of d.abandoned?.old_markets ?? []) push(evm, "Market_archived", true);
  push(d.abandoned_router_v1?.evm, "ActionRouter_v1_archived");
  push(d.abandoned_zap_v1?.evm, "FissionZap_v1_archived");
  for (const evm of d.abandoned?.old_sy_v2_lp ?? []) push(evm, "SY_v1_archived");
  for (const evm of d.abandoned?.old_deployers ?? []) push(evm, "Deployer_archived");

  // Dedup by evm.
  const seen = new Set();
  return list.filter((c) => {
    if (seen.has(c.evm)) return false;
    seen.add(c.evm);
    return true;
  });
}

const CONTRACTS = loadContractsFromDeployments();

// Selector → canonical event_type (constrained by activity_log enum).
// Each top-level user-facing call maps to the protocol-level event that
// best describes what the user just did.
const SELECTOR_TO_EVENT = {
  // ActionRouter v2/v3 — IFissionMarketCommon arg encoded as address
  "0xbf35db06": "swap_sy_for_pt",     // swapExactSyForPt(address,uint256,uint256,address,uint256)
  "0x690b343f": "swap_pt_for_sy",     // swapExactPtForSy(address,uint256,uint256,address,uint256)
  "0xc158091f": "swap_pt_for_sy",     // buyYT(address,uint256,uint256,address,uint256) — composite, fires swap_pt_for_sy
  "0x15ee88c3": "add_liquidity",      // addLiquidityProportional(address,uint256,uint256,uint256,address,uint256)
  "0xcff15d64": "remove_liquidity",   // removeLiquidityProportional(address,uint256,uint256,uint256,address,uint256)
  "0xd1e04b89": "split",              // depositAndSplit(address,uint256,address,address,uint256)
  "0x82b1d54d": "redeem_after_expiry",// redeemAfterExpiryAndUnwrap(address,uint256,uint256,address,uint256)
  // Market (direct)
  "0xdbceb005": "split",              // split(uint256)
  "0x59d20b37": "split",              // splitTo(uint256,address,address)
  "0x1d64ab72": "merge",              // merge(uint256,uint256,address)
  "0x4c2e00d2": "merge",              // merge(uint256,address)
  "0x7fd2778e": "redeem_after_expiry",// redeemAfterExpiry(uint256,address)
  "0xffec999b": "redeem_after_expiry",// redeemAfterExpiry(uint256,uint256,address)
  "0xb576468e": "add_liquidity",      // addLiquidity(uint256,uint256,uint256,address)
  "0xe39b0eb5": "remove_liquidity",   // removeLiquidity(uint256,uint256,uint256,address)
  "0x73a888f6": "swap_sy_for_pt",     // swapExactSyForPt(uint256,uint256,address)
  "0x8488ba33": "swap_pt_for_sy",     // swapExactPtForSy(uint256,uint256,address)
  // SY adapter
  "0x0c887b94": "deposit",            // depositLiquidity(uint256,uint256,uint256,uint256,address,uint128)
  "0x675e3a96": "redeem",             // redeemLiquidity(uint128,uint256,uint256,address)
  "0x4641257d": "claim_rewards",      // harvest()
  "0x4e71d92d": "claim_yield",        // claim()
  // FissionZap — HBAR → SY entry point
  "0xe056955f": "deposit",            // zapHbarToSy(address,uint256,uint256,uint256,uint128,address)
  // MegaZap — HBAR → PT/YT/LP one-shots (selectors verified on-chain 2026-05-25)
  "0x2704fe5e": "swap_sy_for_pt",     // zapHbarToPt(address,address,uint256,address,uint256)
  "0x56cb65ef": "swap_pt_for_sy",     // zapHbarToYt — buyYT-equivalent, fires swap_pt_for_sy
  "0x38307f7b": "add_liquidity",      // zapHbarToLp(address,address,uint16,uint256,address,uint256)
  // FissionUnzap — PT/SY/LP → HBAR one-shots
  "0x151bf8f1": "swap_pt_for_sy",     // sellPtForHbar(address,uint256,uint256,address,uint256)
  "0x05b74d3d": "redeem",             // unzapSy(address,uint256,uint256,address)
  "0x485eb750": "remove_liquidity",   // sellLpForHbar(address,uint256,uint256,address,uint256)
  // FissionPeriphery (2026-05-27 clean-slate redeploy) — 2-tx Buy/Sell flow.
  "0x5cd4b2ba": "deposit",            // zapHbarToSy(address,address,uint256)
  "0x3ab0458a": "swap_sy_for_pt",     // buySyForPt(address,uint256,uint256,address,uint256)
  "0xa6be33fe": "swap_pt_for_sy",     // buySyForYt — composite, fires swap_pt_for_sy
  "0xcbf84c49": "add_liquidity",      // buySyForLp v1 (6-arg) — old Periphery 0x8ce95cef..., kept for archived activity
  "0x171109ef": "add_liquidity",      // buySyForLp v2 (7-arg, ptOutFromSwap) — Periphery v2 0x...a025c1
  "0x33b1da21": "swap_pt_for_sy",     // sellPtForSy(address,uint256,uint256,address,uint256)
  "0x01829011": "swap_pt_for_sy",     // sellYtForSy(address,uint256,uint256,address,uint256) — uses operator path
  "0xde01e48e": "remove_liquidity",   // sellLpForSy(address,uint256,uint256,address,uint256)
  "0x047a7060": "redeem",             // unzapSyToHbar(address,uint256,uint256,uint256)
};

function decodeSelector(callData) {
  if (!callData) return { selector: null, event: null };
  const sel = callData.startsWith("0x")
    ? callData.slice(0, 10).toLowerCase()
    : `0x${callData.slice(0, 8).toLowerCase()}`;
  return { selector: sel, event: SELECTOR_TO_EVENT[sel] ?? null };
}

// Convert mirror's "seconds.nanos" string to an ISO timestamptz.
function mirrorTsToIso(ts) {
  if (!ts) return null;
  const [sec, nanos = "0"] = String(ts).split(".");
  const ms = Number(sec) * 1000 + Math.floor(Number(`0.${nanos.padEnd(9, "0").slice(0, 9)}`) * 1000);
  return new Date(ms).toISOString();
}

async function supaSelect(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`select ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function supaInsert(rows) {
  if (!rows.length) return { inserted: 0 };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`insert ${r.status} ${await r.text()}`);
  return { inserted: rows.length };
}

// activity_log.address has FK → users.address. Auto-register any address we
// see acting on Fission contracts so its rows can land. Profile fields stay
// null; SIWE flow later fills them in for users who actually sign in.
async function ensureUsers(addrs) {
  if (!addrs.size) return;
  const rows = [...addrs].map((address) => ({ address }));
  const r = await fetch(`${SUPABASE_URL}/rest/v1/users?on_conflict=address`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`users upsert ${r.status} ${await r.text()}`);
}

// activity_log unique key is (chain_id, tx_hash, event_type, address). Dedup
// by that composite so multi-event txs (e.g. split + swap from one buyYT) work.
async function knownKeys(rows) {
  if (!rows.length) return new Set();
  const hashes = [...new Set(rows.map((r) => r.tx_hash))];
  const enc = hashes.map((h) => encodeURIComponent(h)).join(",");
  const existing = await supaSelect(`activity_log?select=tx_hash,event_type,address&tx_hash=in.(${enc})`);
  return new Set(existing.map((r) => `${r.tx_hash}|${r.event_type}|${r.address}`));
}

async function pollContract(c) {
  const r = await fetch(`${MIRROR}/contracts/${c.evm}/results?order=desc&limit=${PER_CONTRACT_LIMIT}`);
  if (!r.ok) {
    console.error(JSON.stringify({ t: new Date().toISOString(), step: "fetch_mirror", contract: c.name, status: r.status }));
    return { fetched: 0, inserted: 0, skipped: 0 };
  }
  const j = await r.json();
  const results = j.results ?? [];
  let skipped = 0;
  const candidates = results.map((res) => {
    const { selector, event } = decodeSelector(res.function_parameters);
    if (!event) {
      skipped++;
      return null;
    }
    return {
      address: (res.from ?? "").toLowerCase(),
      chain_id: CHAIN_ID,
      tx_hash: res.hash,
      event_type: event,
      // When called via the market itself, log against that market;
      // otherwise log against the calling contract for grouping.
      market_address: c.market ? c.evm : c.evm,
      payload: {
        contract: c.name,
        contract_evm: c.evm,
        selector,
        to: res.to,
        amount_tinybars: res.amount,
        gas_used: res.gas_used,
        result: res.result,
        error_message: res.error_message ?? null,
        function_parameters: res.function_parameters,
        timestamp_consensus: res.timestamp,
      },
      block_number: res.block_number ?? null,
      block_timestamp: mirrorTsToIso(res.timestamp),
    };
  }).filter((row) => row && row.tx_hash);

  if (!candidates.length) return { fetched: results.length, inserted: 0, skipped };
  const seen = await knownKeys(candidates);
  const fresh = candidates.filter((row) => !seen.has(`${row.tx_hash}|${row.event_type}|${row.address}`));
  if (!fresh.length) return { fetched: results.length, inserted: 0, skipped };
  await ensureUsers(new Set(fresh.map((r) => r.address).filter(Boolean)));
  await supaInsert(fresh);
  return { fetched: results.length, inserted: fresh.length, skipped };
}

async function tick() {
  const started = Date.now();
  let totalFetched = 0, totalInserted = 0, totalSkipped = 0;
  for (const c of CONTRACTS) {
    try {
      const { fetched, inserted, skipped } = await pollContract(c);
      totalFetched += fetched;
      totalInserted += inserted;
      totalSkipped += skipped;
    } catch (e) {
      console.error(JSON.stringify({ t: new Date().toISOString(), contract: c.name, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  const ms = Date.now() - started;
  console.log(JSON.stringify({ t: new Date().toISOString(), fetched: totalFetched, inserted: totalInserted, skipped: totalSkipped, ms }));
}

console.log(JSON.stringify({
  t: new Date().toISOString(),
  msg: "indexer_started",
  intervalMs: INTERVAL_MS,
  contracts: CONTRACTS.length,
  watchlist: CONTRACTS.map((c) => `${c.name}@${c.evm}`),
}));
await tick();
setInterval(tick, INTERVAL_MS);
