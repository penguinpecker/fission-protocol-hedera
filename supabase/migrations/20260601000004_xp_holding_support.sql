-- Holding-XP support: tunable params, snapshot-run tracking, audit value, and a
-- sqrt level curve (magnitude-robust for large holding totals). Holding ledger
-- rows (kind='holding') are written by the /api/xp/holding-sync cron and folded
-- into balances by recompute_xp() (which preserves them).

create table if not exists public.xp_params (
  key        text primary key,
  num        numeric not null,
  updated_at timestamptz not null default now()
);
insert into public.xp_params (key, num) values
  ('holding_xp_per_usd_per_min', 1),   -- 1 XP per $ held per minute
  ('level_sqrt_divisor', 50)           -- level = 1 + floor(sqrt(total_xp)/divisor)
on conflict (key) do nothing;
alter table public.xp_params enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='xp_params' and policyname='xp_params_public_read') then
    create policy "xp_params_public_read" on public.xp_params for select using (true);
  end if;
end $$;
grant select on public.xp_params to anon, authenticated;

create table if not exists public.xp_holding_runs (
  id               bigint generated always as identity primary key,
  run_at           timestamptz not null default now(),
  prev_run_at      timestamptz,
  minutes_elapsed  numeric,
  rate             numeric,
  holders          int,
  total_usd        numeric,
  total_xp_awarded bigint
);
alter table public.xp_holding_runs enable row level security;  -- service-role only

alter table public.xp_ledger add column if not exists usd_value numeric;

create or replace function public.recompute_xp()
returns void language plpgsql security definer set search_path = public as $$
declare divisor numeric;
begin
  select coalesce(num, 50) into divisor from xp_params where key = 'level_sqrt_divisor';
  if divisor is null or divisor <= 0 then divisor := 50; end if;

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
         greatest(1, (1 + floor(sqrt(greatest(sum(points),0)::numeric) / divisor))::int),
         min(block_timestamp), max(block_timestamp), now()
  from xp_ledger
  group by account_id;
end $$;