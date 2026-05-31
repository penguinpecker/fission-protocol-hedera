-- ============================================================
-- XP SYSTEM (v1: on-chain action XP, fully recomputable from activity_log)
-- All XP is derived ONLY from verified on-chain events. Service-role writes only.
-- ============================================================

-- Normalize a Hedera long-zero EVM address (0x0000..00{num}) -> '0.0.<num>'.
-- Returns NULL if not a long-zero form (so unverifiable senders are excluded).
create or replace function public.longzero_to_account(evm text)
returns text language plpgsql immutable as $$
declare h text; n bigint;
begin
  if evm is null then return null; end if;
  h := lower(replace(evm, '0x', ''));
  if length(h) <> 40 then return null; end if;
  if substring(h from 1 for 24) <> repeat('0', 24) then return null; end if;  -- must be long-zero
  n := ('x' || substring(h from 25 for 16))::bit(64)::bigint;                 -- last 8 bytes -> num
  if n is null or n <= 0 then return null; end if;
  return '0.0.' || n::text;
end $$;

-- 1) config: points per action type (tunable without redeploy)
create table if not exists public.xp_config (
  event_type      text primary key,
  action_label    text not null,
  base_points     int  not null default 0,
  daily_cap_count int  not null default 25,
  first_bonus     int  not null default 0,
  enabled         boolean not null default true,
  updated_at      timestamptz not null default now()
);

-- 2) ledger: append-only, one row per award; deterministic + idempotent
create table if not exists public.xp_ledger (
  id              bigint generated always as identity primary key,
  account_id      text not null,
  evm_address     text,
  kind            text not null default 'action',
  ref             text not null,
  event_type      text,
  market_address  text,
  points          int  not null,
  block_timestamp timestamptz,
  created_at      timestamptz not null default now(),
  unique (account_id, kind, ref)
);
create index if not exists xp_ledger_account_idx on public.xp_ledger (account_id);

-- 3) balances: aggregate per account (the leaderboard source)
create table if not exists public.xp_balances (
  account_id      text primary key,
  total_xp        bigint not null default 0,
  action_count    int    not null default 0,
  level           int    not null default 1,
  first_seen      timestamptz,
  last_event_at   timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists xp_balances_total_idx on public.xp_balances (total_xp desc);

-- recompute the whole ledger + balances from activity_log (deterministic, anti-tamper)
create or replace function public.recompute_xp()
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from xp_ledger where kind in ('action','bonus');

  insert into xp_ledger (account_id, evm_address, kind, ref, event_type, market_address, points, block_timestamp)
  with elig as (
    select a.id, a.event_type, a.market_address, a.block_timestamp,
           a.payload->>'from_raw' as from_raw,
           longzero_to_account(a.payload->>'from_raw') as account_id,
           c.base_points, c.daily_cap_count, c.first_bonus
    from activity_log a
    join xp_config c on c.event_type = a.event_type and c.enabled
    where a.payload->>'result' = 'SUCCESS'
      and longzero_to_account(a.payload->>'from_raw') is not null
  ),
  ranked as (
    select *,
      row_number() over (partition by account_id, event_type, (block_timestamp at time zone 'UTC')::date
                         order by block_timestamp, id) as day_rn,
      row_number() over (partition by account_id, event_type order by block_timestamp, id) as ever_rn
    from elig
  )
  select account_id, from_raw, 'action', 'act:'||id, event_type, market_address,
         case when day_rn <= daily_cap_count then base_points else 0 end, block_timestamp
  from ranked
  union all
  select account_id, null, 'bonus', 'first:'||event_type, event_type, null, first_bonus, block_timestamp
  from ranked
  where ever_rn = 1 and first_bonus > 0;

  delete from xp_balances;
  insert into xp_balances (account_id, total_xp, action_count, level, first_seen, last_event_at, updated_at)
  select account_id,
         sum(points)::bigint,
         count(*) filter (where kind = 'action' and points > 0)::int,
         greatest(1, 1 + floor(sum(points)::numeric / 500))::int,
         min(block_timestamp), max(block_timestamp), now()
  from xp_ledger
  group by account_id;
end $$;

-- RLS: public reads config + balances; only service_role writes.
alter table public.xp_config   enable row level security;
alter table public.xp_ledger   enable row level security;
alter table public.xp_balances enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='xp_config' and policyname='xp_config_public_read') then
    create policy "xp_config_public_read" on public.xp_config for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='xp_balances' and policyname='xp_balances_public_read') then
    create policy "xp_balances_public_read" on public.xp_balances for select using (true);
  end if;
end $$;
grant select on public.xp_config, public.xp_balances to anon, authenticated;

-- seed the starter weights (tunable later)
insert into public.xp_config (event_type, action_label, base_points, daily_cap_count, first_bonus) values
  ('deposit',             'Enter (HBAR-SY)',  10, 25, 50),
  ('swap_sy_for_pt',      'Buy PT',           10, 25, 50),
  ('swap_pt_for_sy',      'Sell PT',          10, 25, 50),
  ('split',               'Split (SY-PT+YT)', 10, 25, 50),
  ('merge',               'Merge (PT+YT-SY)', 10, 25, 50),
  ('add_liquidity',       'Provide LP',       25, 25, 75),
  ('remove_liquidity',    'Remove LP',        10, 25,  0),
  ('redeem',              'Exit (SY-HBAR)',   10, 25,  0),
  ('redeem_after_expiry', 'Exit at expiry',   10, 25,  0),
  ('claim_rewards',       'Claim rewards',     5, 50,  0)
on conflict (event_type) do nothing;
