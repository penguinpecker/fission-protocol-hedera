-- referral_stats: compute referral_xp LIVE from counts (100/signup + 1000/tx) so
-- the dashboard never lags the 2-min recompute (equals the leaderboard-credited
-- value in steady state; also shows earned XP for referrers without a 0.0.x yet).
create or replace function public.referral_stats(p_address text)
returns table(total_signups int, signups_with_tx int, referral_xp bigint)
language sql stable security definer set search_path = public as $$
  with mine as (select referee_account_id from referrals where referrer_address = p_address),
  tx_accts as (
    select distinct longzero_to_account(payload->>'from_raw') as acct
    from activity_log
    where payload->>'result' = 'SUCCESS' and longzero_to_account(payload->>'from_raw') is not null
  ),
  agg as (
    select count(*)::int as total,
           count(*) filter (
             where m.referee_account_id is not null
               and exists (select 1 from tx_accts t where t.acct = m.referee_account_id)
           )::int as with_tx
    from mine m
  )
  select total, with_tx, (total::bigint * 100 + with_tx::bigint * 1000) from agg;
$$;

-- referral_list: per-referral detail for the dashboard (who / when / code / status).
create or replace function public.referral_list(p_address text)
returns table(referee_address text, code text, signed_up_at timestamptz, transacted boolean)
language sql stable security definer set search_path = public as $$
  with tx_accts as (
    select distinct longzero_to_account(payload->>'from_raw') as acct
    from activity_log
    where payload->>'result' = 'SUCCESS' and longzero_to_account(payload->>'from_raw') is not null
  )
  select r.referee_address, r.code, r.signed_up_at,
         (r.referee_account_id is not null
          and exists (select 1 from tx_accts t where t.acct = r.referee_account_id)) as transacted
  from referrals r
  where r.referrer_address = p_address
  order by r.signed_up_at desc
  limit 500;
$$;

grant execute on function public.referral_stats(text) to service_role;
grant execute on function public.referral_list(text) to service_role;