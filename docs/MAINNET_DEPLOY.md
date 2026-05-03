# Hedera mainnet deploy runbook

> **READ THIS FIRST.** This document is the only safe path to a mainnet deploy.
> Skipping any step risks user funds. The protocol is **not externally audited**;
> a mainnet deploy is at the operator's risk until at least Phase 9 audit pipeline
> completes (see `docs/IMPLEMENTATION_PLAN.md`).

## Pre-deploy gates

These MUST be satisfied before running any broadcast tx.

- [ ] All 188 tests passing on `main` (`forge test`).
- [ ] Slither baseline clean (`.slither-baseline.md` — 0 high, 0 medium).
- [ ] Coverage baseline met (`.coverage-baseline.md`).
- [ ] **External audit** report committed under `audits/`. Until then this is
      tagged "experimental — operator risk".
- [ ] Safe (multisig) deployed at `multisig.hedera.foundation` and recorded.
- [ ] OZ TimelockController deployed and Safe is its admin.
- [ ] Keeper account funded with HBAR for gas (HBARX market only — V2 LP needs no keeper).
- [ ] Deployer EOA funded with HBAR for the ~5 contract creates (~50 HBAR
      should be plenty).
- [ ] **Tick range chosen for the SaucerSwap V2 LP SY.** Defaults to full range
      (`-887220..887220`, ~1.84% APR, never out-of-range). Tighter ranges earn
      more but go to zero yield when price exits — there is no rebalance.
      Override via `SAUCER_V2_TICK_LOWER` / `SAUCER_V2_TICK_UPPER` env vars.
      The choice is **immutable per-deployment** — picking a new range later
      means deploying a new SY.

## Address pinning

Fixed addresses live in `contracts/script/MainnetAddresses.sol`. Verified
2026-05-02 via Mirror Node + GeckoTerminal:

| Token / contract                     | Hedera ID    | EVM address                                    |
|--------------------------------------|--------------|------------------------------------------------|
| HBARX                                | 0.0.834116   | `0x00000000000000000000000000000000000cba44`   |
| Stader staking (supply key)          | 0.0.1412503  | `0x0000000000000000000000000000000000158d97`   |
| USDC                                 | 0.0.456858   | `0x000000000000000000000000000000000006f89a`   |
| WHBAR (wrapped, ERC-20 facade)       | 0.0.1456986  | `0x0000000000000000000000000000000000163b5a`   |
| SaucerSwap V2 WHBAR-USDC 0.15% pool  |              | `0xc5b707348da504e9be1bd4e21525459830e7b11d`   |
| SaucerSwap V2 NPM (NonFungiblePositionManager) | **TBD** | **set via `SAUCER_V2_NPM` env var**       |

The **Stader contract's `getExchangeRate()` ABI is verified** (selector
`0xe6aa216c`, returns uint256 scaled to 8 decimals). 30-day strict monotonicity
confirmed via 721 hourly samples; ~5.79% APY. Preflight still ABI-pings to
catch any contract upgrade between research and deploy.

**The SaucerSwap V2 NPM address is not statically pinned** — pull the current
canonical address from <https://docs.saucerswap.finance/developerx/contract-deployments>
and pass via `SAUCER_V2_NPM` env var. Preflight calls `positions(uint256)` on it
and verifies the V3 tuple shape comes back.

**v1 lineup decisions (see `memory/research_hedera_sy_underlyings.md`):**
- Bonzo USDC: dropped (user direction).
- SaucerSwap V1 LP: dropped (low TVL/volume on the WHBAR-USDC pair).
- ICHI vault: rejected (rebalance step changes break SY monotonicity).
- SaucerSwap V2 NFT: integrated via Pendle-Kyber pattern (one fixed-range NFT,
  `exchangeRate=1`, fees as reward tokens through `FissionMarketRewards`).

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
export KEEPER_ADDRESS="0x..."        # Hot key, gets KEEPER_ROLE on SY_HBARX only

# SaucerSwap V2 wiring (mandatory)
export SAUCER_V2_NPM="0x..."         # NonFungiblePositionManager (from saucerswap docs)
# Optional V2 overrides
# export SAUCER_V2_POOL="0x..."        # defaults to WHBAR-USDC 0.15% in MainnetAddresses
# export SAUCER_V2_TICK_LOWER="-887220"  # full-range default; tighten for higher APR
# export SAUCER_V2_TICK_UPPER="887220"
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
- **HBARX market** — `factory.createMarket(sy_hbarx, expiry, 50e18, "HBARX-90D")`.
  Rate-growth pattern (FissionMarket). scalarRoot 50e18 = slow-moving curve fits
  the ~5.79% APY HBARX rate. Maturity = +90 days.
- **SaucerSwap V2 LP market** — `factory.createRewardsMarket(sy_saucer_v2_lp, expiry, 75e18, "SS-V2-90D")`.
  Reward-token pattern (FissionMarketRewards). scalarRoot 75e18 = medium curve.
  Maturity = +90 days.
  **Use `createRewardsMarket`, NOT `createMarket`** — sending a reward-bearing
  SY through `createMarket` produces a market whose YT yield path never fires.

Then seed liquidity:

```sh
# admin (Safe) approves SY and PT, then calls:
market.initialize(syIn, ptIn, initialAnchor, lnFeeRateRoot, reserveFeePercent)

# Recommended initial values:
#   syIn / ptIn:        equal — splits a "neutral" position
#   initialAnchor:      1.05e18 (5% implied yield curve start) for HBARX
#                       1.02e18 (2% implied yield) for V2 LP (full-range ~1.84% APR)
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

The keeper only runs for SY_HBARX (postRate of TWAP-bounded Stader rate). The
SaucerSwap V2 LP SY needs no keeper — fees flow through the public `harvest()`
path, callable by any user (and triggered automatically via the Market's reward
forwarding on every YT balance change).

```sh
docker run -d --restart=always \
  -e KEEPER_PRIVATE_KEY=0x... \
  -e KEEPER_ADAPTER_HBARX_SY=$(jq -r .sy_hbarx deployments/295.json) \
  -e KEEPER_ADAPTER_HBARX_STADER=0x0000000000000000000000000000000000158d97 \
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
- Pause every market: `market.pause()` (PAUSER_ROLE) — blocks split/swap/
  addLiquidity. Escape paths (merge / removeLiquidity / claimYield /
  claimRewards / redeemAfterExpiry) remain callable so users are never trapped.

If users have already deposited:

- A rollback IS NOT POSSIBLE. The protocol is non-upgradeable in cores.
  Any rescue would be a follow-on contract that users opt into.

This is why the audit gate matters.
