-- APY / implied-rate time-series for Fission markets.
--
-- markets_cache holds only LATEST state: PK (chain_id, market_address) = one row
-- per market, overwritten on every 60s refresh. There is no time dimension, so
-- the implied-APY moves a user sees (e.g. 8% -> 11%) are not recorded anywhere.
--
-- This append-only table captures the history so the implied-rate / APY / pool
-- depth can be charted and audited over time. The market's implied rate
-- (lastLnImpliedRate) changes ONLY on swaps and is static between trades, so:
--   * source='heartbeat' = periodic capture (the 60s /api/markets/refresh tick
--                          and/or the cron-apy change-gated poller).
--   * source='event'     = reserved for an exact, tx-linked per-trade writer.

create table public.apy_snapshots (
  id                   bigint generated always as identity primary key,
  chain_id             integer     not null check (chain_id > 0),
  market_address       text        not null check (public.is_evm_address(market_address)),
  captured_at          timestamptz not null default now(),         -- UTC
  -- Raw on-chain implied rate (1e18-scaled); reuse the established type used by
  -- markets_cache.last_ln_implied_rate. Stored exactly (string -> numeric).
  last_ln_implied_rate numeric(78, 0) not null,
  -- Derived APY, persisted for cheap charting. MUST match the frontend formula
  -- impliedApyPct = (exp(lastLnImpliedRate/1e18) - 1) * 100. 8 fractional digits
  -- => sub-basis-point precision.
  implied_apy_pct      numeric(12, 8) not null,
  -- Pool-depth context (same units/type as markets_cache).
  total_sy             numeric(78, 0),
  total_pt             numeric(78, 0),
  lp_total_supply      numeric(78, 0),
  -- Provenance.
  source               text not null default 'heartbeat'
                         check (source in ('event', 'heartbeat')),
  -- For source='event': the swap tx that wrote this rate (lets a per-trade
  -- writer dedup re-indexed trades + join to activity_log). Null for heartbeats.
  tx_hash              text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]+$'),
  block_number         bigint
);

-- Primary read pattern: one market's series in time order (charting).
create index apy_snapshots_market_time_idx
  on public.apy_snapshots (chain_id, market_address, captured_at desc);

-- Exact-trade rows must be idempotent across re-indexing: a given swap tx
-- produces exactly one event snapshot per market. Partial so heartbeats
-- (tx_hash null) are never constrained.
create unique index apy_snapshots_event_unique_idx
  on public.apy_snapshots (chain_id, market_address, tx_hash)
  where source = 'event' and tx_hash is not null;

-- ── RLS: public read (charting), service-role write only (mirror markets_cache) ──
alter table public.apy_snapshots enable row level security;

create policy apy_snapshots_select_anyone
  on public.apy_snapshots for select
  using (true);

revoke all on public.apy_snapshots from anon, authenticated;
grant select on public.apy_snapshots to anon, authenticated;
-- No insert/update/delete grants: writes happen only via the service role
-- (which bypasses RLS) from the refresh route + cron-apy poller, exactly like
-- markets_cache.

comment on table public.apy_snapshots is
  'Append-only implied-rate / APY / pool-depth time-series per Fission market. source=heartbeat = periodic capture (60s refresh tick + cron-apy poller); source=event = reserved for an exact per-trade writer. Read via /api/markets/history; written by the refresh route + cron-apy worker, service role only.';

-- ── Optional retention (uncomment after `create extension pg_cron;` in the
--    dashboard). Heartbeats accrue ~1,440 rows/market/day at 60s; prune the old
--    ones while keeping any tx-linked 'event' rows indefinitely (they are rare).
-- select cron.schedule(
--   'prune_apy_snapshots', '17 3 * * *',
--   $$ delete from public.apy_snapshots
--        where source = 'heartbeat'
--          and captured_at < now() - interval '90 days'; $$
-- );
