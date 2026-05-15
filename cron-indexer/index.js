#!/usr/bin/env node
// Fission indexer. Polls Hedera Mirror Node for recent contract calls on the
// six Fission contracts (factory, SY adapter, market, router v3, two zaps),
// decodes the function selector to a human name, and upserts each unique
// (chain_id, tx_hash) into Supabase `activity_log`. Idempotent on tx_hash.

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

// Fission contracts to monitor. The `market_address` column we write into
// activity_log gets the market addr when relevant, otherwise the contract
// itself so we always have a non-null grouping key.
const CONTRACTS = [
  { evm: "0x00000000000000000000000000000000009fb0b3", name: "Factory" },
  { evm: "0x00000000000000000000000000000000009fb089", name: "SY_SaucerSwapV2LP" },
  { evm: "0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d", name: "Market0", market: true },
  { evm: "0x00000000000000000000000000000000009fdf89", name: "ActionRouterV3" },
  { evm: "0x00000000000000000000000000000000009fd984", name: "FissionZap" },
  { evm: "0x00000000000000000000000000000000009fdf8c", name: "MegaZap" },
];

// Selector → canonical event_type (enum-constrained in activity_log).
// Selectors not in this map (approve, transfer, HTS helpers, etc.) are
// skipped — they aren't protocol events.
const SELECTOR_TO_EVENT = {
  // ActionRouter v3
  "0xbf35db06": "swap_sy_for_pt",     // swapExactSyForPt
  "0xc158091f": "swap_pt_for_sy",     // buyYT (composite, but a swap_pt_for_sy fires inside)
  "0xe6f5b25a": "add_liquidity",      // addLiquidityProportional
  "0xa9da11cc": "remove_liquidity",   // removeLiquidityProportional
  "0xc9bf2c2c": "split",              // depositAndSplit
  "0x9be3c50d": "redeem_after_expiry",
  // Market (direct)
  "0xdbceb005": "split",
  "0x24a47aeb": "merge",
  "0xffec999b": "redeem_after_expiry",
  "0xc681bea7": "add_liquidity",
  "0xc23d3eef": "remove_liquidity",
  // SY adapter
  "0xff5f3b56": "deposit",            // depositLiquidity
  "0xb3f5dfc7": "redeem",             // redeemLiquidity
  "0x4641257d": "claim_rewards",      // harvest
  "0x4e71d92d": "claim_yield",        // claim
  // FissionZap / MegaZap (HBAR → SY entry; treat as deposit at the protocol level)
  "0xe056955f": "deposit",            // zapHbarToSy
};

const MARKET0 = "0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d";

function decodeSelector(callData) {
  if (!callData) return { selector: null, event: null };
  const sel = callData.startsWith("0x") ? callData.slice(0, 10).toLowerCase() : `0x${callData.slice(0, 8).toLowerCase()}`;
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
    const { event } = decodeSelector(res.function_parameters);
    if (!event) {
      skipped++;
      return null;
    }
    return {
      address: (res.from ?? "").toLowerCase(),
      chain_id: CHAIN_ID,
      tx_hash: res.hash,
      event_type: event,
      market_address: c.market ? c.evm : MARKET0,
      payload: {
        contract: c.name,
        contract_evm: c.evm,
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

console.log(JSON.stringify({ t: new Date().toISOString(), msg: "indexer_started", intervalMs: INTERVAL_MS, contracts: CONTRACTS.length }));
await tick();
setInterval(tick, INTERVAL_MS);
