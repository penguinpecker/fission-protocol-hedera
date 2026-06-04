-- FIX (live E2E 2026-06-05): the original gas_drip_acquire returned 'acquired'
-- but its INSERT did NOT commit when invoked through PostgREST/supabase-js (the
-- app's path) — verified: rpc returned 'acquired' yet the row never appeared,
-- while structurally-similar functions + direct table writes committed fine. The
-- effect in production was catastrophic for a money function: the RPC reported a
-- slot acquired, the code sent HBAR, but no gas_drips row was ever written — so
-- idempotency AND the budget cap were blind, and a single claim double-sent
-- (both the after() trigger and the /api/claim/gas backup each sent).
--
-- Cure: drop + recreate (fresh OID, clean PostgREST rebind) and fold the
-- failed-retry into a single `insert ... on conflict (address) do update` upsert
-- (the same shape that committed correctly in isolation). Re-verified via the
-- app's supabase-js path that the row now persists.
drop function if exists public.gas_drip_acquire(text, text, numeric, int);
create function public.gas_drip_acquire(
  p_address text, p_account_id text, p_amount numeric, p_max_drips int
) returns text
language plpgsql volatile security definer set search_path = public as $$
declare existing record; used int;
begin
  perform pg_advisory_xact_lock(hashtext('fission_gas_drip'));
  select * into existing from gas_drips where address = p_address;
  if found then
    if existing.status in ('sent', 'submitted') then return 'already_sent'; end if;
    if existing.status = 'pending' then return 'in_progress'; end if;
    if existing.status = 'skipped_funded' then return 'already_sent'; end if;
    -- status = 'failed' → retryable, falls through to the upsert below.
  end if;
  select count(*) into used from gas_drips where status in ('sent', 'submitted', 'pending');
  if used >= p_max_drips then return 'budget_exhausted'; end if;
  insert into gas_drips (address, account_id, amount_hbar, status)
  values (p_address, p_account_id, p_amount, 'pending')
  on conflict (address) do update
    set status = 'pending', amount_hbar = p_amount,
        account_id = coalesce(p_account_id, gas_drips.account_id), tx_hash = null, updated_at = now();
  return 'acquired';
end $$;
grant execute on function public.gas_drip_acquire(text, text, numeric, int) to service_role;