# Fission Protocol — Hedera

Yield tokenization on Hedera. Split yield-bearing tokens (HBARX, SaucerSwap LPs, Bonzo lending positions) into tradeable Principal Tokens (PT) and Yield Tokens (YT).

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

| Component        | Role                                                     |
|------------------|----------------------------------------------------------|
| `FissionFactory` | Deploys PT/YT (as HTS tokens via precompile) per market  |
| `FissionMarket`  | Per-market AMM (Pendle V2-style logit + rate-anchor)     |
| `SY*` adapters   | ERC-5115 wrappers around HBARX / SaucerSwap LP / bUSDC   |
| `ActionRouter`   | Multi-step user flows (deposit → split → swap)           |
| `ProtocolMultisig` + `Timelock` | 3-of-5 with 48h delay on owner actions    |

## License

MIT
