# Hedera mainnet deploy runbook

> **READ THIS FIRST.** This document is the only safe path to a mainnet deploy.
> Skipping any step risks user funds. The protocol is **not externally audited**;
> a mainnet deploy is at the operator's risk until at least Phase 9 audit pipeline
> completes (see `docs/IMPLEMENTATION_PLAN.md`).

## Pre-deploy gates

These MUST be satisfied before running any broadcast tx.

- [ ] All 128 tests passing on `main` (`forge test`).
- [ ] Slither baseline clean (`.slither-baseline.md` — 0 high, 0 medium).
- [ ] Coverage baseline met (`.coverage-baseline.md`).
- [ ] **External audit** report committed under `audits/`. Until then this is
      tagged "experimental — operator risk".
- [ ] Safe (multisig) deployed at `multisig.hedera.foundation` and recorded.
- [ ] OZ TimelockController deployed and Safe is its admin.
- [ ] Keeper account funded with HBAR for gas.
- [ ] Deployer EOA funded with HBAR for the ~6 contract creates (~50 HBAR
      should be plenty).

## Address pinning

Fixed addresses live in `contracts/script/MainnetAddresses.sol`. Verified
2026-05-02 via Mirror Node + Bonzo docs:

| Token / contract           | Hedera ID    | EVM address                                    |
|----------------------------|--------------|------------------------------------------------|
| HBARX                      | 0.0.834116   | `0x00000000000000000000000000000000000cba44`   |
| Stader staking (supply key)| 0.0.1412503  | `0x0000000000000000000000000000000000158d97`   |
| USDC                       | 0.0.456858   | `0x000000000000000000000000000000000006f89a`   |
| Bonzo LendingPool          | 0.0.7308459  | `0x236897c518996163e7b313ad21d1c9fcc7ba1afc`   |
| Bonzo bUSDC                | 0.0.7308496  | `0xb7687538c7f4cad022d5e97cc778d0b46457c5db`   |
| SaucerSwap V1 HBAR-USDC LP | **TBD**      | **set via `SAUCER_V1_LP` env var**             |

The **Stader contract's `getExchangeRate()` ABI is unverified** —
`script/PreFlight.s.sol` ABI-pings it before broadcast and fails closed if the
selector doesn't return a sensible 1e18 rate. If preflight fails on Stader,
options are:
1. Find the correct function selector via HashScan + update `IStaderHBARX`.
2. Switch to a keeper that fetches from Stader's REST API; remove the on-chain
   circuit breaker in `SY_HBARX` for that branch.

**The SaucerSwap V1 LP token address is not pinned** — confirm via SaucerSwap's
subgraph or the V1 frontend, then pass via `SAUCER_V1_LP` env var. Preflight
checks the ABI shape (Uniswap V2 pair with non-zero reserves and totalSupply).
Do NOT use `0xc5b707348da504e9be1bd4e21525459830e7b11d` — that's the V2 pool
(Uni V3 NFT fork), incompatible with `SY_SaucerSwapV1LP`.

## Step 1 — env

```sh
# Required (production)
export HEDERA_MAINNET_RPC="https://mainnet.validationcloud.io/v1/<key>"   # Validation Cloud / Arkhia
export HEDERA_OPERATOR_KEY="0x..."   # Deployer ECDSA — NOT a privileged role-holder

# Governance: ALL of these MUST be the Safe (or a Safe+Timelock proxy)
export FACTORY_ADMIN="0x..."         # Safe
export MARKET_ADMIN="0x..."          # Safe (or Timelock that the Safe controls)
export MARKET_TREASURY="0x..."       # Safe
export SY_ADMIN="0x..."              # Safe

# Operational
export KEEPER_ADDRESS="0x..."        # Hot key, gets KEEPER_ROLE only

# Optional adapter wiring
export SAUCER_V1_LP="0x..."          # Set if deploying the SaucerSwap adapter
```

The `MainnetDeploy` script **refuses to deploy** if any privileged role address
equals the deployer EOA. This is a hard guard against the v1-repo-mistake of
shipping deployer-EOA admin to mainnet.

## Step 2 — preflight (no broadcast)

```sh
cd contracts
forge script script/PreFlight.s.sol \
    --rpc-url $HEDERA_MAINNET_RPC \
    -vvv
```

Expected output: `=== preflight PASSED ===`. Anything else, do NOT proceed.

## Step 3 — broadcast deploy

```sh
forge script script/MainnetDeploy.s.sol \
    --rpc-url $HEDERA_MAINNET_RPC \
    --private-key $HEDERA_OPERATOR_KEY \
    --broadcast --slow -vvv
```

Hashio rate-limits aggressively; `--slow` (one tx at a time) is mandatory.
Production deploy should be done via Validation Cloud or Arkhia for
predictable success.

Addresses land in `deployments/295.json`.

## Step 4 — SY whitelist (Safe-driven, 7-day window)

For each SY adapter:

```sh
# From the Safe, schedule via Timelock:
factory.proposeSY(syAddress)
```

Wait 7 days (contract-enforced — `factory.confirmSY` reverts before window
elapses). Then:

```sh
factory.confirmSY(syAddress)
factory.createMarket(syAddress, expiry, scalarRoot, suffix)
```

Recommended initial markets:
- HBARX market: scalarRoot = 50e18 (slow-moving rate, gentle curve), maturity = +90 days.
- Bonzo USDC market: scalarRoot = 80e18 (medium volatility), maturity = +90 days.

Then seed liquidity:

```sh
# admin (Safe) approves SY and PT, then calls:
market.initialize(syIn, ptIn, initialAnchor, lnFeeRateRoot, reserveFeePercent)

# Recommended initial values:
#   syIn / ptIn:        equal — splits a "neutral" position
#   initialAnchor:      1.05e18 (5% implied yield curve start)
#   lnFeeRateRoot:      0.0003e18 (~0.03% trade fee at curve center)
#   reserveFeePercent:  80 (Pendle default)
```

## Step 5 — verify on HashScan

For each contract:

```sh
forge verify-contract <addr> <Contract> \
    --chain-id 295 \
    --verifier sourcify \
    --verifier-url https://server-verify.hashscan.io
```

## Step 6 — keeper

```sh
docker run -d --restart=always \
  -e KEEPER_PRIVATE_KEY=0x... \
  -e KEEPER_ADAPTER_HBARX_SY=$(jq -r .sy_hbarx deployments/295.json) \
  -e KEEPER_ADAPTER_HBARX_STADER=0x0000000000000000000000000000000000158d97 \
  -e KEEPER_ADAPTER_SAUCER_SY=$(jq -r .sy_saucer_v1_lp deployments/295.json) \
  -e HEDERA_MAINNET_RPC=$HEDERA_MAINNET_RPC \
  -p 8080:8080 \
  fission-keeper
```

Watch `/health` for 24 hours before declaring stable. Failure count > 0 means
either RPC issues or rate-source contract behaviour we didn't anticipate.

## Step 7 — frontend

In the frontend's deployment env (Vercel / Netlify / etc):

```sh
NEXT_PUBLIC_FACTORY_ADDRESS=$(jq -r .factory deployments/295.json)
NEXT_PUBLIC_ROUTER_ADDRESS=$(jq -r .router  deployments/295.json)
NEXT_PUBLIC_RPC_URL=$HEDERA_MAINNET_RPC
```

Trigger a redeploy. The `/markets` page should show the markets you created
in step 4 once their `initialize` is confirmed.

## Step 8 — handoff

The deployer EOA must end with **zero privileged roles** on the live system.
Run on the Safe:

```sh
# For each contract that the deployer was admin of:
factory.beginDefaultAdminTransfer(safeAddress)   # 0 delay since deployer is admin
# 0 hours later (deployer does):
factory.acceptDefaultAdminTransfer()

# Then revoke deployer from any other roles:
factory.revokeRole(MARKET_CREATOR_ROLE, deployerEOA)
factory.revokeRole(SY_REVIEWER_ROLE, deployerEOA)
# ... and so on for each SY
```

Confirm with:

```sh
cast call $factory "hasRole(bytes32,address)(bool)" \
    0x0000000000000000000000000000000000000000000000000000000000000000 \
    $deployerEOA --rpc-url $HEDERA_MAINNET_RPC
# expected: false
```

## Rollback

If something goes wrong post-deploy but pre-funding:

- Pause every SY: `sy.pause()` (PAUSER_ROLE) — blocks deposit/redeem.
- Pause every market: not currently exposed (TODO Phase 9b — add per-market
  pause to FissionMarket; today the only kill-switch is to revoke KEEPER_ROLE
  so rates freeze).

If users have already deposited:

- A rollback IS NOT POSSIBLE. The protocol is non-upgradeable in cores.
  Any rescue would be a follow-on contract that users opt into.

This is why the audit gate matters.
