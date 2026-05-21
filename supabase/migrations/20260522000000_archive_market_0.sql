-- ════════════════════════════════════════════════════════════════════════════
--  Archive Market 0 (Ed25519 reward-accrual bug) + add `is_archived` column.
-- ════════════════════════════════════════════════════════════════════════════
--
--  Context:
--    Market 0 (0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d) is the live mainnet
--    market deployed pre-Ed25519-fix. The fix lives in immutable contracts, so
--    we redeploy. Old market stays on-chain (LP/PT/SY all withdrawable for its
--    holders) but should not be surfaced in the dApp's primary market list.
--
--    See audits/internal/SECURITY_REVIEW_ED25519_BAL_2026-05-22.md.
--
--  Migration:
--    - add `is_archived` (default false) to markets_cache
--    - flag Market 0 archived
--    - add partial index for active markets (the common query path)
--    - public read policy unchanged (still grants SELECT to anon/authenticated)
--
--  The new market entry will land via the indexer cron once deployed.

alter table public.markets_cache
  add column if not exists is_archived boolean not null default false;

-- Reason kept here in the row itself (audit-trail style — no separate notes table).
alter table public.markets_cache
  add column if not exists archived_reason text;

alter table public.markets_cache
  add column if not exists archived_at timestamptz;

-- Partial index: dApp filters out archived markets in the hot path.
create index if not exists markets_cache_active_idx
  on public.markets_cache (chain_id, factory_address)
  where is_archived = false;

-- Flag the broken Market 0 archived. Idempotent: if the row isn't present yet
-- (indexer hasn't seen it), the update is a no-op and we leave behind a marker
-- via a small "pre-archived" sentinel — when indexer first inserts, it picks up
-- the archived flag from the sentinel.
do $$
declare
  market_row_exists boolean;
begin
  select exists (
    select 1 from public.markets_cache
    where chain_id = 295
      and lower(market_address) = '0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d'
  ) into market_row_exists;

  if market_row_exists then
    update public.markets_cache
       set is_archived = true,
           archived_reason = 'Ed25519 reward-accrual bug (see audits/internal/SECURITY_REVIEW_ED25519_BAL_2026-05-22.md). Replaced by fixed-contract redeploy 2026-05-22.',
           archived_at = '2026-05-22T00:00:00Z'
     where chain_id = 295
       and lower(market_address) = '0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d';
    raise notice 'Archived existing Market 0 row.';
  else
    -- Insert a pre-archived sentinel so the indexer never surfaces it on first
    -- discovery either. Uses minimal placeholder values; the indexer will
    -- update them when it actually runs against this market (UPSERT path).
    insert into public.markets_cache (
      chain_id, market_address, market_type, factory_address, sy_address,
      pt_address, yt_address, lp_address, initialized,
      is_archived, archived_reason, archived_at
    ) values (
      295,
      '0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d',
      'rewards',
      '0x00000000000000000000000000000000009fb0b3',
      '0x00000000000000000000000000000000009fb089',
      '0x00000000000000000000000000000000009fb0b5',
      '0x00000000000000000000000000000000009fb0b6',
      '0x00000000000000000000000000000000009fb0b7',
      true,
      true,
      'Ed25519 reward-accrual bug (see audits/internal/SECURITY_REVIEW_ED25519_BAL_2026-05-22.md). Replaced by fixed-contract redeploy 2026-05-22.',
      '2026-05-22T00:00:00Z'
    );
    raise notice 'Inserted pre-archived sentinel for Market 0.';
  end if;
end $$;
