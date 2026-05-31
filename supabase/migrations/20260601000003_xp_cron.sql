-- Schedule the XP recompute fully DB-side (every 2 minutes) + seed initial balances.
-- The recompute is deterministic + idempotent, so re-running is always safe.
create extension if not exists pg_cron;

-- (re)schedule cleanly
select cron.unschedule('xp-recompute')
where exists (select 1 from cron.job where jobname = 'xp-recompute');

select cron.schedule('xp-recompute', '*/2 * * * *', 'select public.recompute_xp();');

-- initial population
select public.recompute_xp();
