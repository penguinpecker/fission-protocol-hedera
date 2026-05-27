-- Server-side session revocation table.
--
-- Why: prior to this, sessions were stateless 7-day JWTs (HS256 with
-- SESSION_SECRET). Logout just cleared the browser cookie; a captured cookie
-- remained cryptographically valid for the full 7-day TTL with no recovery
-- path other than rotating SESSION_SECRET (which invalidates ALL sessions).
--
-- This migration adds a `sessions` table tracking every issued JWT by its
-- `jti` (UUID). verifySession() now joins against this table — any token
-- whose jti is missing, revoked, or past-expiry → reject. Logout writes
-- revoked_at. Compromised cookies can be killed individually.
--
-- Old tokens (no jti) → rejected forcibly (they predate this schema).
-- Operator + any active users get a single forced re-login on deploy.

create table if not exists public.sessions (
  jti uuid primary key,
  address text not null check (public.is_evm_address(address)),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent_summary text check (user_agent_summary is null or char_length(user_agent_summary) <= 200)
);

-- Hot path: verifySession lookups by jti.
create index if not exists sessions_jti_active_idx
  on public.sessions (jti)
  where revoked_at is null;

-- For an "active sessions per user" admin view.
create index if not exists sessions_address_active_idx
  on public.sessions (address)
  where revoked_at is null;

-- For periodic cleanup of expired rows.
create index if not exists sessions_expires_idx
  on public.sessions (expires_at);

-- RLS: service-role only. No grants to anon/authenticated.
alter table public.sessions enable row level security;
revoke all on public.sessions from anon, authenticated;

-- One-time housekeeping: any future Vercel cron route hitting
-- /api/auth/cleanup should also DELETE expired rows here.
