-- ════════════════════════════════════════════════════════════════════════════
--  Track session metadata on users + enrich activity_log payload (NO IPs).
-- ════════════════════════════════════════════════════════════════════════════
--
--  Per product call 2026-05-25: do NOT collect IP addresses. Skipping IPs
--  avoids GDPR/CCPA classification of stored data as PII tied to network
--  identifiers, which would otherwise require a published privacy policy
--  and explicit user consent before SIWE login. If/when a privacy policy
--  ships, a separate migration can add an `ip_inet` column behind a feature
--  flag — leave this one alone.
--
--  Schema additions:
--    users.last_sign_in_at      — most recent SIWE verify
--    users.sign_in_count        — monotonic counter incremented on verify
--    users.first_seen_at        — first time the address acted on Fission
--                                  (back-fillable from earliest activity_log)
--    users.user_agent_summary   — UA-parsed "browser/os" string only; full
--                                  UA string is intentionally NOT stored
--    users.last_chain_id        — most recent chain the user signed in from
--
--  activity_log gets no schema additions in this migration — the indexer's
--  JSONB `payload` column already holds gas_used, selector, function_parameters,
--  amount_tinybars, etc. The richer fields land there.
--
-- ════════════════════════════════════════════════════════════════════════════

alter table public.users
  add column if not exists last_sign_in_at timestamptz,
  add column if not exists sign_in_count integer not null default 0,
  add column if not exists first_seen_at timestamptz,
  add column if not exists user_agent_summary text
    check (user_agent_summary is null or char_length(user_agent_summary) <= 200),
  add column if not exists last_chain_id integer
    check (last_chain_id is null or last_chain_id > 0);

-- Helpful for "active in last 30d" queries on the admin side.
create index if not exists users_last_sign_in_idx
  on public.users (last_sign_in_at desc nulls last);

-- Back-fill first_seen_at for existing rows from the earliest activity_log
-- entry per address (best-effort, idempotent).
update public.users u
   set first_seen_at = sub.first_ts
  from (
    select address, min(block_timestamp) as first_ts
      from public.activity_log
     where block_timestamp is not null
     group by address
  ) sub
 where u.address = sub.address
   and u.first_seen_at is null;

-- ─── record_sign_in RPC ─────────────────────────────────────────────────────
--
-- Single-statement upsert + monotonic counter increment. Called by
-- /api/auth/verify after the SIWE nonce has been consumed. Keeps the route
-- to one round-trip and avoids races between concurrent verifies for the
-- same address.

create or replace function public.record_sign_in(
  p_address text,
  p_user_agent_summary text,
  p_chain_id integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (
    address, first_seen_at, last_sign_in_at, sign_in_count,
    user_agent_summary, last_chain_id
  ) values (
    lower(p_address), now(), now(), 1,
    p_user_agent_summary, p_chain_id
  )
  on conflict (address) do update
     set last_sign_in_at = excluded.last_sign_in_at,
         sign_in_count = public.users.sign_in_count + 1,
         user_agent_summary = excluded.user_agent_summary,
         last_chain_id = excluded.last_chain_id,
         first_seen_at = coalesce(public.users.first_seen_at, excluded.first_seen_at);
end;
$$;

-- Service role only — anon/authenticated must NOT call this directly (the
-- API route is the gatekeeper, after nonce consumption).
revoke execute on function public.record_sign_in(text, text, integer) from public, anon, authenticated;
grant execute on function public.record_sign_in(text, text, integer) to service_role;
