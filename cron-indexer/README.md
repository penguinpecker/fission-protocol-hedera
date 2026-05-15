# cron-indexer

Polls Hedera Mirror Node every minute for new contract calls on each of the
six Fission contracts (Factory, SY adapter, Market 0, ActionRouter v3,
FissionZap, MegaZap), decodes the function selector, and upserts each unique
`(chain_id, tx_hash)` into Supabase `activity_log`.

Idempotent — re-running on the same window inserts zero rows.

## Env

- `SUPABASE_URL` — e.g. `https://atjsjwebftwbaellnuuy.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — service-role JWT (server-only)
- `INTERVAL_MS` (optional, default 60000)
- `PER_CONTRACT_LIMIT` (optional, default 50)

## Deploy

```sh
cd cron-indexer
railway up
```
