# Fission Protocol — Hedera

Yield tokenization on Hedera. Split yield-bearing positions (HBARX liquid staking, SaucerSwap V2 LP) into tradeable Principal Tokens (PT) and Yield Tokens (YT).

> Production rebuild — design goals are **real on-chain rate sources** (no mocks), **HTS-native PT/YT** for native wallet visibility, **multisig + timelock governance**, and **audit-ready** quality with invariant fuzzing.

## Status

Pre-architecture. Research and rebuild plan in progress. Do not deploy.

## Layout

```
contracts/   Foundry-first Solidity (tests, invariants, fuzzing)
             Hardhat for Hedera mainnet deploy + HashScan verification
frontend/    Next.js 15 + HashConnect/WalletConnect (HashPack, Blade, MetaMask)
keeper/      Off-chain rate-poster service (Hedera SDK)
audits/      External audit reports
deployments/ Per-network address ledger
```

## Architecture (intended)

| Component               | Role                                                                   |
|-------------------------|------------------------------------------------------------------------|
| `FissionFactory`        | Deploys PT/YT (as HTS tokens via precompile) per market                |
| `FissionMarket`         | AMM for rate-growth SYs (HBARX). Pendle V2 logit + rate-anchor curve   |
| `FissionMarketRewards`  | AMM for reward-bearing SYs (V3-LP). Pendle-Kyber pattern, exchangeRate=1, fees as reward tokens |
| `SY_HBARX`              | ERC-5115 over Stader's HBARX (TWAP-bounded keeper-posted rate)         |
| `SY_SaucerSwapV2LP`     | ERC-5115 over a fixed-range SaucerSwap V2 NFT position                 |
| `ActionRouter`          | Multi-step user flows (deposit → split → swap)                         |
| 2-of-2 ThresholdKey + OZ Timelock | Hedera-native 2-of-2 account → 48h Timelock → admin of every contract |

## Docs

- [`docs/ECONOMICS.md`](docs/ECONOMICS.md) — how PT, YT, LP, and SY actually accumulate value. Worked examples for every role and scenario. Required reading before using the UI.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and contract topology.
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — phased build plan and current state.
- [`docs/MAINNET_DEPLOY.md`](docs/MAINNET_DEPLOY.md) — operator runbook for mainnet ops.

## License

MIT
