# Hedera mainnet deploy runbook

> **READ THIS FIRST.** This document is the only safe path to a mainnet deploy.
> Skipping any step risks user funds. The protocol is **not externally audited**;
> a mainnet deploy is at the operator's risk until at least Phase 9 audit pipeline
> completes (see `docs/IMPLEMENTATION_PLAN.md`).

## Pre-deploy gates

These MUST be satisfied before running any broadcast tx.

- [ ] All **269 tests** passing on `main` + 7 fork tests against live RPC (`forge test` + `forge test --match-path 'test/fork/**' --fork-url $HEDERA_MAINNET_RPC`).
- [ ] **Two internal audit passes complete** (`audits/internal/SECURITY_REVIEW_2026-05-02.md` + `-pass2.md`); 0 open H/M findings; all Lows accepted/documented.
- [ ] Slither + Aderyn re-baselined post-fixes; flags classified.
- [ ] Branch coverage: FissionMarket 73%, FissionMarketRewards 70%, ActionRouter 82%, FissionFactory 60%. Below those thresholds → audit firm pre-review will reject.
- [ ] **External audit** report committed under `audits/`. Until then this is
      tagged "experimental — operator risk".
- [ ] Safe (multisig) deployed at `multisig.hedera.foundation` and recorded.
- [ ] OZ TimelockController deployed and Safe is its admin.
- [ ] **HIP-1217 verification:** every privileged role address (`FACTORY_ADMIN`,
      `MARKET_ADMIN`, `SY_ADMIN`, `MARKET_TREASURY`, `KEEPER_ADDRESS`) is either
      a contract or an EVM-aliased ECDSA account — **NOT a long-zero ECDSA alias**.
      Since HIP-1217 (active 2026), HTS calls to long-zero ECDSA aliases revert.
      Verify each address has either nonzero `code.length` (contract / Safe) or
      shows a non-`0x000…XXX` form on HashScan.
- [ ] **HIP-904 reliance:** all token-holding contracts (SY adapters, Markets,
      Router) rely on Hedera's auto-association default. Contracts deployed in
      2024+ get `maxAutomaticTokenAssociations = -1` automatically. If you ever
      target a Hedera version where this default differs, add explicit
      `IHRC.associate(token)` calls.
- [ ] Keeper account funded with HBAR for gas (HBARX market only — V2 LP needs no keeper).
- [ ] Deployer EOA funded with HBAR for the ~5 contract creates (~50 HBAR
      should be plenty).
- [ ] **Tick range chosen for the SaucerSwap V2 LP SY.** Defaults to full range
      (`-887220..887220`, ~1.84% APR, never out-of-range). Tighter ranges earn
      more but go to zero yield when price exits — there is no rebalance.
      Override via `SAUCER_V2_TICK_LOWER` / `SAUCER_V2_TICK_UPPER` env vars.
      The choice is **immutable per-deployment** — picking a new range later
      means deploying a new SY.

## Audit fixes baked into the deploy

Every fix from `audits/internal/SECURITY_REVIEW_2026-05-02*.md` is shipping in
this deploy. Operators should be aware of the runtime behavior changes:

- **H-1 (SY rate floor at 1e18).** `FissionMarket.initialize` and
  `FissionMarketRewards.initialize` revert with `SYRateBelowOne(syRate)` if the
  SY's `exchangeRate()` returns < 1e18 at deploy time. `_updateGlobalIndex` also
  floors at 1e18 mid-life. Implication: if SY_HBARX has had no keeper post yet
  at initialize-time, the cold-start fallback returns exactly `PMath.ONE` (M-3),
  passing the floor.
- **H-2 (try/catch around `sy.claimRewards`).** A reverting SY no longer bricks
  YT mint/transfer/burn in `FissionMarketRewards`. The Market emits
  `HarvestSkipped(reason)` and continues. Implication: keep an eye on the event
  in the indexer — recurring `HarvestSkipped` signals an underlying SY problem.
- **H-3 (no-pull-on-empty).** `_harvestRewards` and the SY's `_harvest()`
  early-return when `totalSupply() == 0`, preventing orphaned-reward forfeit.
  Implication: don't expect rewards to accrue between SY-deploy and the first
  user split — the V3 position holds them in `feeGrowthInside` until then.
- **H-4 (auto-redeem-LP-PT-share at expiry).** `removeLiquidity` post-expiry
  returns `ptOut == 0` and pays the LP only SY (PT redeemed at the frozen
  `globalIndex` rate in FissionMarket, 1:1 in FissionMarketRewards). LP exits
  no longer race PT redeemers for the SY backing.
- **M-1 (fee-on-transfer guard).** `SYBase.deposit` snapshots pre-balance and
  passes the actual delta to `_deposit`. Fee-on-transfer HTS tokens won't
  inflate share price.
- **M-2 (YT burn rejected in FissionMarketRewards).** `redeemAfterExpiry`
  reverts with `YTBurnNotPermitted` if `ytIn != 0`. Frontend must NOT pass
  ytIn when calling redeemAfterExpiry on a rewards-bearing market.
- **M-3 (SY_HBARX cold-start).** `exchangeRate()` returns `PMath.ONE` before
  the first keeper post (rather than reverting). Dependent contracts always
  see a sane value.
- **M-NEW-1 (harvest reentrancy).** `_harvestRewards` uses `sy.claimRewards`'s
  return value (not balance-delta) so a future hook-bearing reward token can't
  short the index update.
- **L-6 (deposit slippage).** `SY_SaucerSwapV2LP.depositLiquidity` now takes
  `(amount0Min, amount1Min)` symmetric to `redeemLiquidity`. Frontend must
  set these for sandwich protection.
- **L-8 (MIN_MARKET_DURATION).** Factory rejects markets with `expiry <
  block.timestamp + 7 days`.
- **L-11 (admin must be contract).** `setMarketAdmin` rejects EOAs.

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
`0xe6aa216c`, returns uint256 scaled to **18 decimals**, not 8 — corrected
via live fork test 2026-05-02; live value `1.40e18`). 30-day strict
monotonicity confirmed via 721 hourly samples; ~5.79% APY. Preflight still
ABI-pings to catch any contract upgrade between research and deploy.

The **SaucerSwap V2 NPM is now pinned**: Hedera `0.0.4053945` / EVM
`0x00000000000000000000000000000000003DDbb9`. LP NFT collection HTS
`0.0.4054027`. `SAUCER_V2_NPM` env var is optional (falls back to constant).

The SaucerSwap V2 NPM is statically pinned in `MainnetAddresses.sol`. Live
fork test (`test/fork/SY_SaucerSwapV2LP.fork.t.sol`) verifies the NPM exposes
`positions(uint256)` with the expected V3 tuple and the WHBAR-USDC pool has
bytecode. Run that fork test before broadcast as the final ABI sanity check.

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

# SaucerSwap V2 wiring (all optional — defaults pinned in MainnetAddresses.sol)
# export SAUCER_V2_NPM="0x..."           # default 0x...3DDbb9 (Hedera 0.0.4053945)
# export SAUCER_V2_POOL="0x..."          # default WHBAR-USDC 0.15%
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

**Forge can't broadcast the full lineup on Hedera mainnet.** Two reasons:
(a) Foundry's local revm pre-simulates every tx, and HTS precompile calls
revert there because revm has no `0x167`. (b) FissionFactory bytecode plus
Hashio's 15M-gas-per-tx cap means even ContractCreate via JSON-RPC fails on
contracts above ~28KB runtime. Use the Hedera-SDK-based scripts instead:

```sh
# 1) Router + both SY adapters (each <12M gas → fits Hashio).
node scripts/deploy-mainnet.mjs

# 2) Init each SY's HTS share token. The HTS createFungibleToken
#    precompile cannot be called from a constructor on consensus
#    (the spawned child TOKENCREATION HAPI tx ends up with max_fee=0).
#    Two-step pattern: deploy → external `initShareToken()` payable.
#    Payable amount must be ≥ 15 HBAR (token create + 90d auto-renew
#    prepay) AND must go through the SDK's ContractExecuteTransaction
#    with setPayableAmount — Hashio's EthereumTransaction relay does
#    NOT propagate value to the child HAPI's fee budget.
node scripts/init-sy.mjs <sy-evm-address> 15

# 3) FissionFactory + the two MarketDeployer helpers via the SDK
#    (FileCreate + FileAppend + ContractCreate, since Factory's bytecode
#    chunks past the SDK's default 20-chunk max).
ROUTER_ADDRESS=0x... \
SY_HBARX_ADDRESS=0x... \
SY_SAUCER_V2_LP_ADDRESS=0x... \
node scripts/deploy-mainnet-sdk.mjs
```

Why two MarketDeployer contracts: FissionFactory at 71KB runtime exceeded
Hedera's 15M gas-per-tx ContractCreate cap (G_codedeposit alone = ~14.2M
gas). Extracted `new FissionMarket(...)` and `new FissionMarketRewards(...)`
into `StandardMarketDeployer` + `RewardsMarketDeployer`. Factory shrunk to
8KB. Both Market constructors take an explicit `factory_` address; the
deployer passes it through.

Operator HBAR cost (mainnet, observed):
- Router + each SY adapter: ~3 HBAR / contract via Hashio
- Each `initShareToken`: 15 HBAR (paid through, plus ~1 HBAR network fee)
- Factory + 2 deployers via SDK FileService: ~30 HBAR total
- **Total: ~80-100 HBAR** with margin.

Production should run from Validation Cloud or Arkhia (Hashio is dev-only).
For the SDK scripts, swap `Client.forMainnet()` to a custom client pointing
at the chosen consensus node set.

Addresses land in `deployments/295.json`.

## Step 4 — SY whitelist (Safe-driven, 7-day window)

For each SY adapter, propose to start the 7-day review window:

```sh
node scripts/propose-sy.mjs <factory-evm> <sy-evm-1> [<sy-evm-2> ...]
```

Wait 7 days (contract-enforced — `factory.confirmSY` reverts before window
elapses). Then confirm and create markets:

```sh
node scripts/confirm-sy.mjs <factory-evm> <sy-evm-1> [<sy-evm-2> ...]

FACTORY_ADDRESS=0x... \
SY_HBARX_ADDRESS=0x... \
SY_SAUCER_V2_LP_ADDRESS=0x... \
STD_EXPIRY=<unix>  RWD_EXPIRY=<unix> \
STD_SCALAR_ROOT=50e18 RWD_SCALAR_ROOT=75e18 \
STD_SUFFIX="HBARX-90D" RWD_SUFFIX="SS-V2-90D" \
node scripts/create-markets.mjs
```

`createMarket` sends 20 HBAR `payableAmount` per market — covers the three
HTS createFungibleToken calls inside `setTokens` (PT, YT, LP) plus their
90-day auto-renew prepayments. Same SDK-vs-Hashio rule as `initShareToken`:
must use `ContractExecuteTransaction.setPayableAmount`.

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

```sh
forge verify-contract <addr> <Contract> \
    --chain-id 295 \
    --verifier sourcify \
    --verifier-url https://server-verify.hashscan.io
```

**Caveat: `foundry.toml` currently sets `bytecode_hash = "none"` and
`cbor_metadata = false`** to keep deployed bytecode reproducible without
the metadata-changes-per-source-comment churn. Sourcify's *full match*
requires the metadata hash embedded in the runtime code, so without it only
*partial match* (bytecode-equality, no source/metadata pairing) is
possible. To get a full Sourcify match, enable metadata in `foundry.toml`,
recompile, and redeploy from those artifacts before running the verify.

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
