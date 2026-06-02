-- FIX (referral tracking audit): referral XP was keyed to the snapshotted 0.0.x
-- (referrer/referee_account_id), which is NULL for not-yet-on-chain ECDSA wallets
-- -> XP silently dropped from the leaderboard while the dashboard still showed it.
-- Cure: resolve through a single fresh source, users.account_id (set on every
-- sign-in + a daily sweep), falling back to the snapshot. Recompute/referral_stats/
-- referral_list all resolve referrer & referee accounts through users.account_id.
-- (The ECDSA-form users.account_id backfill ran as a one-time data UPDATE via the
-- management API; long-zero users are seeded below in SQL.)

alter table public.users add column if not exists account_id text;
create index if not exists users_account_id_idx on public.users (account_id);

update public.users
   set account_id = longzero_to_account(address)
 where account_id is null and longzero_to_account(address) is not null;

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
  ),
  res as (
    select r.referee_address, r.signed_up_at,
           coalesce(ur.account_id, r.referrer_account_id) as rr_acct,
           coalesce(ue.account_id, r.referee_account_id)  as re_acct
    from referrals r
    left join users ur on ur.address = r.referrer_address
    left join users ue on ue.address = r.referee_address
  )
  select rr_acct, 'referral', 'ref-signup:'||referee_address, 'referral_signup', 100, signed_up_at
  from res where rr_acct is not null
  union all
  select rr_acct, 'referral', 'ref-tx:'||referee_address, 'referral_tx', 1000, signed_up_at
  from res
  where rr_acct is not null and re_acct is not null
    and exists (select 1 from tx_accts t where t.acct = re_acct);

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

create or replace function public.referral_stats(p_address text)
returns table(total_signups int, signups_with_tx int, referral_xp bigint)
language sql stable security definer set search_path = public as $$
  with mine as (
    select coalesce(ue.account_id, r.referee_account_id) as re_acct
    from referrals r left join users ue on ue.address = r.referee_address
    where r.referrer_address = p_address
  ),
  tx_accts as (
    select distinct longzero_to_account(payload->>'from_raw') as acct
    from activity_log
    where payload->>'result' = 'SUCCESS' and longzero_to_account(payload->>'from_raw') is not null
  ),
  agg as (
    select count(*)::int as total,
           count(*) filter (
             where m.re_acct is not null and exists (select 1 from tx_accts t where t.acct = m.re_acct)
           )::int as with_tx
    from mine m
  )
  select total, with_tx, (total::bigint * 100 + with_tx::bigint * 1000) from agg;
$$;

create or replace function public.referral_list(p_address text)
returns table(referee_address text, code text, signed_up_at timestamptz, transacted boolean)
language sql stable security definer set search_path = public as $$
  with tx_accts as (
    select distinct longzero_to_account(payload->>'from_raw') as acct
    from activity_log
    where payload->>'result' = 'SUCCESS' and longzero_to_account(payload->>'from_raw') is not null
  )
  select r.referee_address, r.code, r.signed_up_at,
         (coalesce(ue.account_id, r.referee_account_id) is not null
          and exists (select 1 from tx_accts t where t.acct = coalesce(ue.account_id, r.referee_account_id))) as transacted
  from referrals r
  left join users ue on ue.address = r.referee_address
  where r.referrer_address = p_address
  order by r.signed_up_at desc
  limit 500;
$$;
grant execute on function public.referral_stats(text) to service_role;
grant execute on function public.referral_list(text) to service_role;