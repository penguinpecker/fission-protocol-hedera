# cron-refresh

Railway cron worker that POSTs `/api/markets/refresh` on `fissionp.com` every
minute, keeping the Supabase `markets_cache` warm. The frontend already falls
through to live chain reads when the cache is stale, so this worker is a
**performance optimization**, not a correctness requirement.

## Env

- `REFRESH_URL` — `https://www.fissionp.com/api/markets/refresh`
- `CRON_SECRET` — must match Vercel prod `CRON_SECRET`

## Deploy

```sh
cd cron-refresh
railway up
```

Schedule is set in `railway.toml` (`*/1 * * * *`).
