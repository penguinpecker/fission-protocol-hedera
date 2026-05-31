-- Accounts hidden from the public leaderboard (team/deployer wallets, bots, etc.).
-- XP is still computed for them; they're just filtered out of the board.
create table if not exists public.xp_excluded (
  account_id text primary key,
  reason     text,
  created_at timestamptz not null default now()
);
alter table public.xp_excluded enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='xp_excluded' and policyname='xp_excluded_public_read') then
    create policy "xp_excluded_public_read" on public.xp_excluded for select using (true);
  end if;
end $$;
grant select on public.xp_excluded to anon, authenticated;

insert into public.xp_excluded (account_id, reason) values
  ('0.0.10495279', 'operator / current deployer (team)'),
  ('0.0.10463169', 'old deployer (team)')
on conflict (account_id) do nothing;
