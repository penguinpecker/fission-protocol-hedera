-- ════════════════════════════════════════════════════════════════════════════
--  Fission Protocol — Supabase schema, v1.
-- ════════════════════════════════════════════════════════════════════════════
--
--  Identity model: SIWE (Sign-In With Ethereum).
--    - The user's EVM address IS the user id (stored lowercased everywhere).
--    - One-shot nonces in `auth_nonces` enforce single-use challenges.
--
--  ⚠️ RLS STATUS — READ THIS (corrected 2026-05-29, WEB2-RLS-01):
--    The policies below were WRITTEN assuming a Supabase-Auth JWT carrying the
--    address in `sub`, scoped via `public.jwt_address()` (which reads
--    `request.jwt.claims`). That assumption is NOT how auth actually works.
--    Authentication is a CUSTOM HS256 cookie minted in app code
--    (frontend/src/lib/auth/session.ts) — it is NOT a Supabase JWT and is never
--    presented to PostgREST. Every request that touches user data goes through
--    the SERVICE-ROLE client (frontend/src/lib/supabase/server.ts), which
--    BYPASSES RLS entirely.
--      ⇒ `public.jwt_address()` always returns '' in production.
--      ⇒ Every `... = public.jwt_address()` policy below is therefore INERT —
--        it neither grants nor (since service-role bypasses RLS) restricts.
--    THE REAL SECURITY BOUNDARY is per-route, in application code: each
--    /api/* handler calls getSession() and filters its query by the session's
--    own address (`.eq('address', s.address)`). The policies are kept as
--    defense-in-depth ONLY for the (currently unused) anon/authenticated path;
--    do not rely on them while the service-role routes are the access path.
--
--  Security defaults:
--    - RLS enabled on EVERY table (but see the RLS STATUS note above — inert
--      against the service-role access path the app actually uses).
--    - All tables default-deny; access only via explicit policies.
--    - `auth_nonces` is service-role-only — never reachable from the anon /
--      authenticated client.
--    - PII-minimization: only optional self-set display fields. No emails in v1.
--    - Address normalization enforced by CHECK + trigger (lowercased 0x-prefixed
--      40-hex-char EVM address).
--    - updated_at maintained by trigger.
--    - Foreign-key cascades: a user delete cascades through all owned rows.
--    - Service role does NOT bypass RLS for the auth_nonces table operations
--      that touch user-claimed state (server enforces in app code).
--    - All grants use anon/authenticated; service_role only where strictly
--      needed (see api role discussion in README).
--
-- ════════════════════════════════════════════════════════════════════════════

-- pgcrypto for gen_random_uuid() (gen_random_bytes() also available).
create extension if not exists pgcrypto;

-- ─── helpers ────────────────────────────────────────────────────────────────

-- Lowercased EVM-address sanity check.
create or replace function public.is_evm_address(addr text)
returns boolean
language sql
immutable
parallel safe
as $$
  select addr is not null
    and addr ~ '^0x[a-f0-9]{40}$';
$$;

-- ⚠️ INERT in production (WEB2-RLS-01): this expects a Supabase-Auth JWT in
-- `request.jwt.claims`, but the app authenticates with a custom HS256 cookie
-- that is never sent to PostgREST, and all user-data access runs through the
-- service-role client (which bypasses RLS). In practice this returns '' for
-- every request. Retained only so the RLS policies remain syntactically valid
-- should an anon/authenticated JWT path ever be wired up. See the header note.
create or replace function public.jwt_address()
returns text
language sql
stable
as $$
  select lower(coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )) ;
$$;

-- Trigger: maintain updated_at.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- DEAD CODE (WEB2-LOWERCASE-03): this trigger function was never attached to
-- any table and its body is buggy (it selects one column value into the whole
-- NEW record and never lowercases or writes back). Address lowercasing is
-- handled in app code + enforced by the is_evm_address CHECK constraints.
-- It is DROPPED by migration 20260529000000_drop_dead_lower_address_trigger.sql.
-- Left here unchanged only to preserve this migration's historical bytes.
create or replace function public.lower_address_columns()
returns trigger
language plpgsql
as $$
begin
  if tg_argv is not null then
    -- Iterate tg_argv (column names) and lowercase NEW.<col> dynamically.
    for i in 0 .. array_length(tg_argv, 1) - 1 loop
      execute format('select ($1).%I', tg_argv[i]) into new using new;
    end loop;
  end if;
  return new;
end;
$$;

-- ─── users ──────────────────────────────────────────────────────────────────

create table public.users (
  address text primary key
    check (public.is_evm_address(address)),
  display_name text
    check (display_name is null or char_length(display_name) between 1 and 32),
  avatar_url text
    check (avatar_url is null or char_length(avatar_url) <= 2048),
  twitter_handle text
    check (twitter_handle is null or twitter_handle ~ '^[A-Za-z0-9_]{1,15}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- ─── auth_nonces (server-only) ──────────────────────────────────────────────
--
-- Single-use SIWE nonces. The /api/auth/nonce route INSERTs; /api/auth/verify
-- atomically marks them consumed via a conditional UPDATE. No client should
-- ever read or write this table — anon + authenticated have zero grants.

create table public.auth_nonces (
  nonce text primary key
    check (char_length(nonce) = 64 and nonce ~ '^[a-f0-9]{64}$'),
  address text not null
    check (public.is_evm_address(address)),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index auth_nonces_address_idx on public.auth_nonces (address);
-- For periodic cleanup of expired+consumed rows (cron / pg_cron).
create index auth_nonces_expires_idx on public.auth_nonces (expires_at)
  where consumed_at is null;

-- ─── watchlists ─────────────────────────────────────────────────────────────

create table public.watchlists (
  address text not null
    references public.users(address) on delete cascade
    check (public.is_evm_address(address)),
  chain_id integer not null check (chain_id > 0),
  market_address text not null
    check (public.is_evm_address(market_address)),
  added_at timestamptz not null default now(),
  primary key (address, chain_id, market_address)
);

create index watchlists_address_idx on public.watchlists (address);

-- ─── notification preferences ───────────────────────────────────────────────

create table public.notification_prefs (
  address text primary key
    references public.users(address) on delete cascade
    check (public.is_evm_address(address)),
  expiry_alerts boolean not null default true,
  yield_change_alerts boolean not null default false,
  yield_change_bps_threshold integer not null default 50
    check (yield_change_bps_threshold between 1 and 10000),
  -- Email is opt-in, hashed-at-rest is excessive for a notification target.
  -- We accept the standard email format but DO NOT verify or send anything
  -- in v1. RLS still scopes per-user.
  email text
    check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_at timestamptz not null default now()
);

create trigger notification_prefs_set_updated_at
  before update on public.notification_prefs
  for each row execute function public.set_updated_at();

-- ─── activity log (per-user tx history cache) ──────────────────────────────
--
-- Local cache of a user's protocol interactions. Source of truth is the
-- chain (Mirror Node); this table is just a UX index. Service role inserts
-- after watching events; users can read their own rows.

create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  address text not null
    references public.users(address) on delete cascade
    check (public.is_evm_address(address)),
  chain_id integer not null check (chain_id > 0),
  tx_hash text not null check (tx_hash ~ '^0x[a-f0-9]{64}$'),
  event_type text not null
    check (event_type in (
      'split','merge','swap_pt_for_sy','swap_sy_for_pt',
      'add_liquidity','remove_liquidity','claim_yield','claim_rewards',
      'redeem_after_expiry','deposit','redeem'
    )),
  market_address text
    check (market_address is null or public.is_evm_address(market_address)),
  payload jsonb,
  block_number bigint,
  block_timestamp timestamptz,
  unique (chain_id, tx_hash, event_type, address)
);

create index activity_log_address_idx on public.activity_log (address, block_timestamp desc);
create index activity_log_market_idx on public.activity_log (chain_id, market_address)
  where market_address is not null;

-- ─── markets cache (public read, service write) ────────────────────────────

create table public.markets_cache (
  chain_id integer not null check (chain_id > 0),
  market_address text not null check (public.is_evm_address(market_address)),
  market_type text not null check (market_type in ('standard','rewards')),
  factory_address text not null check (public.is_evm_address(factory_address)),
  sy_address text not null check (public.is_evm_address(sy_address)),
  pt_address text check (pt_address is null or public.is_evm_address(pt_address)),
  yt_address text check (yt_address is null or public.is_evm_address(yt_address)),
  lp_address text check (lp_address is null or public.is_evm_address(lp_address)),
  expiry timestamptz,
  scalar_root_e18 numeric(78, 0),
  total_pt numeric(78, 0),
  total_sy_shares numeric(78, 0),
  last_ln_implied_rate numeric(78, 0),
  lp_total_supply numeric(78, 0),
  initialized boolean not null default false,
  last_synced timestamptz not null default now(),
  primary key (chain_id, market_address)
);

create index markets_cache_factory_idx on public.markets_cache (chain_id, factory_address);

-- ════════════════════════════════════════════════════════════════════════════
--  Row Level Security
-- ════════════════════════════════════════════════════════════════════════════

alter table public.users enable row level security;
alter table public.auth_nonces enable row level security;
alter table public.watchlists enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.activity_log enable row level security;
alter table public.markets_cache enable row level security;

-- ── users ──
-- Public profiles: anyone (incl. anon) may read. Only the owner may write.
create policy users_select_anyone
  on public.users for select
  using (true);

create policy users_insert_self
  on public.users for insert
  to authenticated
  with check (lower(address) = public.jwt_address());

create policy users_update_self
  on public.users for update
  to authenticated
  using (lower(address) = public.jwt_address())
  with check (lower(address) = public.jwt_address());

create policy users_delete_self
  on public.users for delete
  to authenticated
  using (lower(address) = public.jwt_address());

-- ── auth_nonces ──
-- Zero policies: only service role (which bypasses RLS) can touch this. No
-- grants will be issued to anon/authenticated below.

-- ── watchlists ──
create policy watchlists_select_self
  on public.watchlists for select
  to authenticated
  using (lower(address) = public.jwt_address());

create policy watchlists_insert_self
  on public.watchlists for insert
  to authenticated
  with check (lower(address) = public.jwt_address());

create policy watchlists_delete_self
  on public.watchlists for delete
  to authenticated
  using (lower(address) = public.jwt_address());

-- ── notification_prefs ──
create policy notification_prefs_select_self
  on public.notification_prefs for select
  to authenticated
  using (lower(address) = public.jwt_address());

create policy notification_prefs_insert_self
  on public.notification_prefs for insert
  to authenticated
  with check (lower(address) = public.jwt_address());

create policy notification_prefs_update_self
  on public.notification_prefs for update
  to authenticated
  using (lower(address) = public.jwt_address())
  with check (lower(address) = public.jwt_address());

create policy notification_prefs_delete_self
  on public.notification_prefs for delete
  to authenticated
  using (lower(address) = public.jwt_address());

-- ── activity_log ──
-- Users read their own. Inserts happen via service role from the indexer.
create policy activity_log_select_self
  on public.activity_log for select
  to authenticated
  using (lower(address) = public.jwt_address());

-- ── markets_cache ──
-- Public read, service write.
create policy markets_cache_select_anyone
  on public.markets_cache for select
  using (true);

-- ════════════════════════════════════════════════════════════════════════════
--  Grants
-- ════════════════════════════════════════════════════════════════════════════

-- Default-deny by revoking all on every table.
revoke all on public.users from anon, authenticated;
revoke all on public.auth_nonces from anon, authenticated;
revoke all on public.watchlists from anon, authenticated;
revoke all on public.notification_prefs from anon, authenticated;
revoke all on public.activity_log from anon, authenticated;
revoke all on public.markets_cache from anon, authenticated;

-- users
grant select on public.users to anon, authenticated;
grant insert, update, delete on public.users to authenticated;

-- watchlists
grant select, insert, delete on public.watchlists to authenticated;

-- notification_prefs
grant select, insert, update, delete on public.notification_prefs to authenticated;

-- activity_log
grant select on public.activity_log to authenticated;

-- markets_cache: public read.
grant select on public.markets_cache to anon, authenticated;

-- auth_nonces gets ZERO grants — service role only via the API routes.

-- Function exec grants (helper functions are stable/immutable).
grant execute on function public.is_evm_address(text) to anon, authenticated;
grant execute on function public.jwt_address() to anon, authenticated;
