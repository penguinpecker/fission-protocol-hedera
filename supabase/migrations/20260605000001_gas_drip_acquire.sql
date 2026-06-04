-- Atomic drip-slot acquisition. Serializes ALL concurrent drip attempts via a
-- single advisory lock, so the budget cap is a HARD ceiling (no count-then-insert
-- TOCTOU) and the per-wallet lock is exact. Also revives a prior 'failed' row
-- (transient failures retryable) without ever reviving a 'sent'/'submitted' row
-- (no double-send). Budget counts sent+submitted+pending so a broadcast-but-
-- unconfirmed 'submitted' tx still counts against the cap.
create or replace function public.gas_drip_acquire(
  p_address text,
  p_account_id text,
  p_amount numeric,
  p_max_drips int
) returns text
language plpgsql security definer set search_path = public as $$
declare
  existing record;
  used int;
begin
  perform pg_advisory_xact_lock(hashtext('fission_gas_drip'));

  select * into existing from gas_drips where address = p_address;
  if found then
    if existing.status in ('sent', 'submitted') then return 'already_sent'; end if;
    if existing.status = 'pending' then return 'in_progress'; end if;
    if existing.status = 'skipped_funded' then return 'already_sent'; end if;
    -- status = 'failed' → fall through and re-acquire a slot (retryable).
  end if;

  select count(*) into used from gas_drips where status in ('sent', 'submitted', 'pending');
  if used >= p_max_drips then return 'budget_exhausted'; end if;

  if found then
    update gas_drips
       set status = 'pending', amount_hbar = p_amount,
           account_id = coalesce(p_account_id, account_id), tx_hash = null, updated_at = now()
     where address = p_address;
  else
    insert into gas_drips (address, account_id, amount_hbar, status)
    values (p_address, p_account_id, p_amount, 'pending');
  end if;
  return 'acquired';
end $$;
grant execute on function public.gas_drip_acquire(text, text, numeric, int) to service_role;

-- Operator visibility: counts by status + HBAR committed (sent+submitted+pending).
create or replace function public.gas_drip_stats()
returns table(total int, sent int, submitted int, pending int, failed int, skipped int, hbar_committed numeric)
language sql stable security definer set search_path = public as $$
  select count(*)::int,
         count(*) filter (where status = 'sent')::int,
         count(*) filter (where status = 'submitted')::int,
         count(*) filter (where status = 'pending')::int,
         count(*) filter (where status = 'failed')::int,
         count(*) filter (where status = 'skipped_funded')::int,
         coalesce(sum(amount_hbar) filter (where status in ('sent', 'submitted', 'pending')), 0)
  from gas_drips;
$$;
grant execute on function public.gas_drip_stats() to service_role;