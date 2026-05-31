-- ============================================================
-- REFERRAL SYSTEM. Attribution happens at SIWE sign-in (both MetaMask + HashPack
-- collapse to one canonical EVM address), so both wallet types track the same.
-- Referral XP is DERIVED in recompute_xp from the referrals table (deterministic
-- + recomputable), keyed by the referrer's 0.0.x → flows into xp_balances +
-- leaderboard. Service-role-only (all access via authed routes).
-- ============================================================

create table if not exists public.referral_codes (
  code             text primary key check (length(code) between 4 and 6),
  owner_address    text not null unique,
  owner_account_id text,
  created_at       timestamptz not null default now()
);

create table if not exists public.referrals (
  referee_address     text primary key,            -- one referrer per referee (first-touch)
  referrer_address    text not null,
  code                text not null,
  referrer_account_id text,                          -- 0.0.x (XP keying)
  referee_account_id  text,                          -- 0.0.x (first-tx detection)
  signed_up_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  check (referee_address <> referrer_address)        -- no self-referral
);
create index if not exists referrals_referrer_idx on public.referrals (referrer_address);
create index if not exists referrals_referrer_acct_idx on public.referrals (referrer_account_id);

alter table public.referral_codes enable row level security;  -- service-role only
alter table public.referrals      enable row level security;  -- service-role only

-- Extend recompute_xp: derive referral XP (signup 100 + first-tx 1000, additive).
-- Rebuilds action+bonus+referral deterministically; preserves holding; re-aggregates.
create or replace function public.recompute_xp()
returns void language plpgsql security definer set search_path = public as $$
declare divisor numeric;
begin
  select coalesce(num, 50) into divisor from xp_params where key = 'level_sqrt_divisor';
  if divisor is null or divisor <= 0 then divisor := 50; end if;

  delete from xp_ledger where kind in ('action','bonus','referral');

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

  insert into xp_ledger (account_id, kind, ref, event_type, points, block_timestamp)
  with tx_accts as (
    select distinct longzero_to_account(payload->>'from_raw') as acct
    from activity_log
    where payload->>'result' = 'SUCCESS' and longzero_to_account(payload->>'from_raw') is not null
  )
  select r.referrer_account_id, 'referral', 'ref-signup:'||r.referee_address, 'referral_signup', 100, r.signed_up_at
  from referrals r where r.referrer_account_id is not null
  union all
  select r.referrer_account_id, 'referral', 'ref-tx:'||r.referee_address, 'referral_tx', 1000, r.signed_up_at
  from referrals r
  where r.referrer_account_id is not null
    and r.referee_account_id is not null
    and exists (select 1 from tx_accts t where t.acct = r.referee_account_id);

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

-- Per-referrer dashboard stats in one call.
create or replace function public.referral_stats(p_address text)
returns table(total_signups int, signups_with_tx int, referral_xp bigint)
language sql stable security definer set search_path = public as $$
  with mine as (select referee_account_id from referrals where referrer_address = p_address),
  tx_accts as (
    select distinct longzero_to_account(payload->>'from_raw') as acct
    from activity_log
    where payload->>'result' = 'SUCCESS' and longzero_to_account(payload->>'from_raw') is not null
  )
  select
    (select count(*)::int from mine),
    (select count(*)::int from mine m where m.referee_account_id is not null
       and exists (select 1 from tx_accts t where t.acct = m.referee_account_id)),
    coalesce((select sum(l.points) from xp_ledger l
       join referral_codes c on c.owner_account_id = l.account_id
       where c.owner_address = p_address and l.kind = 'referral'), 0)::bigint;
$$;
grant execute on function public.referral_stats(text) to service_role;