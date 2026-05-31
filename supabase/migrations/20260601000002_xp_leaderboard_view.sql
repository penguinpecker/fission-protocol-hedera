-- Public leaderboard view: balances minus excluded (team) wallets, pre-ranked.
create or replace view public.xp_leaderboard as
select row_number() over (order by b.total_xp desc, b.last_event_at desc nulls last, b.account_id) as rank,
       b.account_id,
       b.total_xp,
       b.level,
       b.action_count,
       b.last_event_at
from public.xp_balances b
left join public.xp_excluded x on x.account_id = b.account_id
where x.account_id is null
  and b.total_xp > 0;

grant select on public.xp_leaderboard to anon, authenticated;
