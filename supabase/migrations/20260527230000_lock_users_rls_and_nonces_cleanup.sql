-- Lock down public.users read access + add auth_nonces cleanup primitives.
--
-- Why:
--   1. The original `users_select_anyone` policy + `grant select on users to
--      anon` meant the public anon API key could SELECT *all* user rows —
--      addresses, Twitter handles, last sign-in, sign-in counts, UA summary.
--      Pure PII leak. The frontend never reads users via the anon client (all
--      profile reads go through /api/* which uses service role), so locking
--      this down has no functional impact.
--   2. auth_nonces lacked a fast (address) lookup and had no cleanup path.

-- ── users: drop public-read, replace with self-read only ──
drop policy if exists users_select_anyone on public.users;

create policy users_select_self
  on public.users for select
  to authenticated
  using (lower(address) = public.jwt_address());

revoke select on public.users from anon;
-- authenticated keeps the GRANT it already has (line 318 of init.sql).

-- ── auth_nonces: index + one-time cleanup ──
create index if not exists auth_nonces_active_idx
  on public.auth_nonces (address)
  where consumed_at is null;

-- One-time cleanup of stale rows. Future periodic cleanup is handled by a
-- Vercel cron route hitting /api/auth/cleanup, gated by CRON_SECRET.
delete from public.auth_nonces
  where (consumed_at is not null and consumed_at < now() - interval '1 day')
     or (consumed_at is null and expires_at < now() - interval '1 hour');
