-- Make sign-up-only referrers appear on the leaderboard. Referral XP is keyed to
-- a UNIFIED identity coalesce(users.account_id, referrer_account_id, referrer_address)
-- — never null — so a referrer with no on-chain Hedera account still gets an
-- xp_balances row (under their wallet address) and ranks on the board. It
-- auto-merges into their 0.0.x row once the account resolves (full-rebuild recompute).
-- (Only recompute_xp changes; everything else is unchanged from the prior migration.)
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
           coalesce(ur.account_id, r.referrer_account_id, r.referrer_address) as rr_key,
           coalesce(ue.account_id, r.referee_account_id) as re_acct
    from referrals r
    left join users ur on ur.address = r.referrer_address
    left join users ue on ue.address = r.referee_address
  )
  select rr_key, 'referral', 'ref-signup:'||referee_address, 'referral_signup', 100, signed_up_at
  from res
  union all
  select rr_key, 'referral', 'ref-tx:'||referee_address, 'referral_tx', 1000, signed_up_at
  from res
  where re_acct is not null and exists (select 1 from tx_accts t where t.acct = re_acct);

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