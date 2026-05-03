# Fission Keeper

Off-chain rate poster for the SY_HBARX adapter. Reads Stader's `getExchangeRate()`
and posts to SY_HBARX with bps + interval gating that mirrors (and pre-empts) the
contract-side caps.

Note: SY_SaucerSwapV2LP needs no keeper. Its yield path is `harvest()` (anyone
callable) plus the Market's auto-trigger on every YT balance change.

## Run locally

```
npm install
cp ../.env.example .env   # populate KEEPER_PRIVATE_KEY and KEEPER_ADAPTER_* vars
npm run dev
```

## Run via Docker

```
docker build -t fission-keeper .
docker run --rm \
  -e KEEPER_PRIVATE_KEY=0x... \
  -e KEEPER_ADAPTER_HBARX_SY=0x... \
  -e KEEPER_ADAPTER_HBARX_STADER=0x... \
  -p 8080:8080 \
  fission-keeper
```

## Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `KEEPER_PRIVATE_KEY` | yes | — | ECDSA key for the keeper account; needs `KEEPER_ROLE` on every SY |
| `HEDERA_MAINNET_RPC` | no | `https://mainnet.hashio.io/api` | Use Validation Cloud or Arkhia in prod |
| `KEEPER_INTERVAL_SECONDS` | no | `3600` | Loop period; SY contract enforces ≥1h |
| `KEEPER_MAX_DELTA_BPS` | no | `50` | Soft cap; contract enforces hard cap |
| `PORT` | no | `8080` | Health endpoint listens here |
| `KEEPER_ADAPTER_HBARX_SY` | yes | — | Address of the SY_HBARX adapter |
| `KEEPER_ADAPTER_HBARX_STADER` | yes | — | Stader's getExchangeRate contract |

If `KEEPER_ADAPTER_HBARX_SY` is unset the keeper exits with an error.

## Health and metrics

- `GET /health` — JSON with last successful post, failure counts, uptime.
- `GET /metrics` — minimal Prometheus exposition.

## Logging

JSON-structured to stdout (info/warn) and stderr (error). Pipe to your shipper.

## Safety guards

The keeper's job is to stay UNDER the contract's enforcement. The contract enforces:

- Min 1h between posts
- ≤ 50 bps delta per post
- ≤ 200 bps deviation from a fresh oracle read or the SY auto-pauses

Hitting any of these is a bug — the keeper logs and skips, never burns gas on a
tx that would revert.

## Adding a new adapter

1. Add a discriminated case to `RateSource` in `src/types.ts`.
2. Implement the fetch in `src/sources/<kind>.ts`.
3. Wire into `src/sources/index.ts`.
4. Add an env-var block to `src/index.ts`.
5. Document in this README.
