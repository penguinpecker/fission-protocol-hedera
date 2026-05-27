# Hedera mainnet deploy runbook

> **READ THIS FIRST.** This document is the only safe path to a mainnet deploy.
> Skipping any step risks user funds. The protocol is **not externally audited**;
> a mainnet deploy is at the operator's risk.

> **2026-05-27 update — Clean-slate redeploy + audit pass-2 LIVE.**
> Current production set (all per `deployments/295.json`):
> - FissionFactory: `0x799549F698bBBAc90B9e1C37eF3946A1A1d3397c` / `0.0.10495346`
> - FissionPeriphery v3: `0x0000000000000000000000000000000000a02731` / `0.0.10495793`
> - FissionLens: `0xa1aAfc8C11A686a3Dee5DfE8B19D9eB43d321969` / `0.0.10495350`
> - SaucerSwapLPYieldSource v2: `0x0000000000000000000000000000000000a0289a` / `0.0.10496154`
> - Market USDC-WHBAR-2026-08-25-v3: `0xfD33CCB2385EC20C4B7bc682712fb92e01e87D5f` / `0.0.10496157`
> - StandardMarketDeployer: `0xdbDf8da50240F21DFc1ed6c44e3a5806AFDcC9bF` / `0.0.10495325`
> - RewardsMarketDeployer:  `0x63A75EaaB07feeBc48226A6eaF3Cbb057614e537` / `0.0.10495326`
>
> All prior contracts (Factory `0x...a00b4e`, Periphery v1/v2, SY adapter v1
> `0x...a02585`, market `0x556938...`, ActionRouter v3, FissionZap, MegaZap,
> FissionUnzap, FissionGateway v2/v2.1) are abandoned but on-chain. The dApp
> routes only to v3. Historical state archived in `deployments/295.json` +
> `markets_cache.is_archived=true`.
>
> All deploy scripts that produced this state are in `scripts/`:
> `deploy-rebuild.mjs`, `deploy-periphery-v2.mjs`, `deploy-periphery-v3.mjs`,
> `deploy-sy-v2-cascade.mjs`, `seed-rebuild.mjs`, `fund-market.mjs`,
> `smoke-rebuild.mjs`, `smoke-v3.mjs`. See `records.txt` for the full timeline.

> **v1.0 launch decision (2026-05-08):** the bootstrap factory at
> `0x00000000000000000000000000000000009fb0b3` (`SY_REVIEW_WINDOW=0`) is
> being adopted as the production factory. Penpie defence is dropped from
> v1 because admin is already a Hedera 2-of-2 ThresholdKey + 48h Timelock —
> a malicious SY proposal would require both cosigner sigs AND a 48h waiting
> period before it could be confirmed, judged sufficient defense-in-depth
> for v1. **Steps 1-7 below describe a fresh redeploy** and are reference
> material; for v1.0 follow the operator-first flow: build/seed under
> deployer EOA admin, then run only Step 8 (handoff). Appendix B Phase C is
> only relevant if v1.1 requires a redeploy with the 7-day window.

## Pre-deploy gates

These MUST be satisfied before running any broadcast tx.

- [ ] All **269 tests** passing on `main` + 7 fork tests against live RPC (`forge test` + `forge test --match-path 'test/fork/**' --fork-url $HEDERA_MAINNET_RPC`).
- [ ] **Two internal audit passes complete** (`audits/internal/SECURITY_REVIEW_2026-05-02.md` + `-pass2.md`); 0 open H/M findings; all Lows accepted/documented.
- [ ] Slither + Aderyn re-baselined post-fixes; flags classified.
- [ ] Branch coverage: FissionMarket 73%, FissionMarketRewards 70%, ActionRouter 82%, FissionFactory 60%. Below those thresholds → audit firm pre-review will reject.
- [ ] **External audit** report committed under `audits/`. Until then this is
      tagged "experimental — operator risk".
- [ ] Hedera 2-of-2 ThresholdKey account created via SDK and recorded (account ID + EVM alias).
- [ ] OZ TimelockController deployed; proposer = executor = ThresholdKey account's EVM alias; admin = `address(0)`.
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

# Governance: ALL of these MUST be either the 2-of-2 ThresholdKey account
# (its EVM alias) OR the Timelock that the threshold account controls.
export FACTORY_ADMIN="0x..."         # Timelock
export MARKET_ADMIN="0x..."          # Timelock
export MARKET_TREASURY="0x..."       # ThresholdKey account EVM alias (no delay needed for fee withdraws)
export SY_ADMIN="0x..."              # Timelock

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

Then seed liquidity. Wrapped end-to-end in `scripts/initialize-hbarx-market.mjs`
(HBARX → SY.deposit → market.split → market.initialize). Prerequisite the
operator must hold BEFORE running:

  • **HBARX in operator wallet.** Stake HBAR via Stader
    (https://stader.staderlabs.com/hedera) — current rate ~1.40 HBAR per HBARX.
    For a 10-HBARX seed (≈14 HBAR worth on each side of the AMM), stake at
    least ~30 HBAR.
  • The HBARX HTS (0.0.834116) must be **token-associated** to the operator
    account. Most wallets handle this on first receive; explicit association
    via `TokenAssociateTransaction` if not.

Run:

```sh
# Read freshly-deployed addresses from the source of truth.
MARKET_ADDRESS=$(jq -r '.markets[] | select(.suffix=="HBARX-90D") | .evm' deployments/295.json) \
SY_HBARX_ADDRESS=$(jq -r '.sy_hbarx.evm' deployments/295.json) \
HBARX_TO_DEPOSIT=1000000000   `# 10 HBARX (8 dec)` \
SY_TO_SPLIT=500000000         `# 5 SY shares` \
SY_IN=500000000               `# 5 SY for AMM` \
PT_IN=500000000               `# 5 PT for AMM (neutral, equal sides)` \
INITIAL_ANCHOR_E18=1050000000000000000   `# 1.05e18` \
LN_FEE_RATE_ROOT_E18=300000000000000     `# 0.0003e18` \
RESERVE_FEE_PERCENT=80 \
node scripts/initialize-hbarx-market.mjs
```

**DO NOT** copy the example addresses out of an older runbook. Any
`sy_hbarx` / market address that predates this deploy carries pre-fix
bugs (see "Hedera deploy gotchas" appendix below). Always pull from
`deployments/295.json` at deploy-time.

Recommended values (HBARX-90D market):
  • syIn / ptIn equal — neutral starting position
  • initialAnchor = 1.05e18 — 5% implied yield curve start (HBARX is ~5.79% APY)
  • lnFeeRateRoot = 0.0003e18 — ~0.03% trade fee at curve center
  • reserveFeePercent = 80 — Pendle default protocol cut

For Market 1 (SaucerSwap V2 LP rewards): use `scripts/initialize-saucer-market.mjs`,
which wraps HBAR → WHBAR, swaps half to USDC, deposits both into
SY_SaucerSwapV2LP (mints a V3 NFT, credits SY shares), splits to PT/YT,
and calls `market.initialize`. Resume flags: `SKIP_WRAP=1` if you already
hold WHBAR, `SKIP_SWAP=1` if you already hold USDC. `initialAnchor = 1.02e18`
(2% implied yield, matches the ~1.84% APR baseline for the WHBAR-USDC 0.15%
pool full-range).

## Step 5 — verify on HashScan

```sh
forge verify-contract <addr> <Contract> \
    --chain-id 295 \
    --verifier sourcify \
    --verifier-url https://server-verify.hashscan.io
```

**Caveats:**
1. `foundry.toml` currently sets `bytecode_hash = "none"` and
   `cbor_metadata = false`. Sourcify's *full match* requires the metadata
   hash embedded in the runtime code, so without it only *partial match*
   (bytecode-equality, no source/metadata pairing) is possible.
2. **Sourcify's recompile path doesn't reproduce Foundry's `via_ir = true`
   output bit-for-bit** — even when local artifact bytecode is byte-identical
   to the deployed runtime, Sourcify's recompiler returns
   `"The deployed and recompiled bytecode don't match"`. See
   `scripts/sourcify-verify.mjs` for the standard JSON input we send (works
   end-to-end, but Sourcify still rejects the recompile result). The
   pragmatic workarounds: (a) use HashScan's manual verification UI which
   accepts uploaded artifacts as-is; (b) wait for the Sourcify
   `viaIR`-stable release that pins solc's IR pipeline output; (c) drop
   `via_ir` and recompile the entire stack with stack-optimizer pipeline
   (will likely break the markets that need IR for `stack too deep`).

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
Per OZ `AccessControlDefaultAdminRules`, `DEFAULT_ADMIN_ROLE` transfer is a
two-party process: the current admin (deployer EOA) *begins* the transfer;
the pending new admin (the Timelock contract) *accepts* it.

```sh
# 1. Deployer EOA begins the transfer for every admin'd contract:
cast send $factory "beginDefaultAdminTransfer(address)" $timelock \
    --rpc-url $HEDERA_MAINNET_RPC --private-key $DEPLOYER_KEY
# repeat for: $sy_hbarx, $sy_saucer_v2_lp, each market

# 2. The Timelock can't call `acceptDefaultAdminTransfer()` itself — Timelock
#    only acts on `schedule() + execute()`. Instead, the 2-of-2 ThresholdKey
#    account broadcasts a `Timelock.schedule(target, value, data, predecessor,
#    salt, delay=0)` for the accept call (the protocol Timelock is the new
#    admin, but the threshold account drives it). After the 48h elapses (or
#    immediately if you queue with `delay=0` only at first cutover, then
#    raise to 48h after the handoff), threshold account broadcasts
#    `Timelock.execute(...)`. Helper script `scripts/prep-handoff.mjs`
#    outputs both Hedera SDK ContractExecuteTransaction snippets ready to
#    sign 2-of-2 in HashPack.
```

Then revoke the deployer's non-default roles. These are flat OZ AccessControl
calls; the Timelock executes each `revokeRole` call after `DEFAULT_ADMIN_ROLE`
has been transferred to it (only the default admin can revoke):

```sh
# Roles that may have been granted to the deployer at construction time:
#   factory:  ADMIN_ROLE  (proposeSY / confirmSY / setProtocolFee)
#   markets:  ADMIN_ROLE, PAUSER_ROLE
#   SYs:      ADMIN_ROLE, PAUSER_ROLE, KEEPER_ROLE  (KEEPER moves to dedicated EOA)
# Use `scripts/prep-handoff.mjs` to dump the full Tx Builder JSON.
```

Confirm with:

```sh
cast call $factory "hasRole(bytes32,address)(bool)" \
    0x0000000000000000000000000000000000000000000000000000000000000000 \
    $deployerEOA --rpc-url $HEDERA_MAINNET_RPC
# expected: false (deployer has no DEFAULT_ADMIN_ROLE)
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

---

## Appendix A — Hedera deploy gotchas (12 hard-won lessons)

Each item below tripped a previous deploy and is now fixed in the source.
Read these even if everything looks fine — they explain *why* the runbook
prefers SDK paths over Hashio JSON-RPC for certain steps.

1. **HTS `createFungibleToken` cannot be called from a constructor.**
   The child `TOKENCREATION` HAPI tx is born with `max_fee = 0` and reverts.
   Two-step pattern only: deploy → external `initShareToken()` payable.
   `payableAmount ≥ 15 HBAR` (token create + 90-day auto-renew prepay) and
   it MUST go through the SDK's `ContractExecuteTransaction.setPayableAmount`.
   Hashio's `EthereumTransaction` relay does NOT propagate `value` into the
   child HAPI's fee budget. (`scripts/init-sy.mjs`.)

2. **15M-gas-per-tx ContractCreate cap on Hashio mainnet.**
   FissionFactory at 71KB runtime needed >15M gas for `G_codedeposit` alone
   and reverted with `MAX_GAS_LIMIT_EXCEEDED`. Fix: extracted
   `new FissionMarket(...)` / `new FissionMarketRewards(...)` into
   `StandardMarketDeployer` + `RewardsMarketDeployer`. Both Market
   constructors take an explicit `factory_` param; the deployer passes
   it through. Factory shrunk 71KB → 8KB.

3. **`ContractCreateFlow.execute` ignores `setMaxChunks`.**
   The non-signer convenience path silently caps at 20 chunks, which
   isn't enough for big bytecode. Use the explicit `FileCreate +
   FileAppend(setMaxChunks) + ContractCreate` sequence instead.
   (`scripts/deploy-mainnet-sdk.mjs`.)

4. **`HtsHelpers.createFungible` was using `msg.value` directly.**
   When called 3× from `setTokens` (PT / YT / LP), each call requested the
   full `msg.value`, draining the contract on the first call and reverting
   the next two. Fix: explicit `value` param; `setTokens` splits
   `msg.value / 3` per call (last call gets rounding remainder).

5. **`SY_REVIEW_WINDOW` was a hard-coded `7 days` constant.**
   Converted to `immutable` set via constructor. Production deploy passes
   `7 days`; bootstrap (only used to ship Market 0 for smoke-test) passes
   `0`. `MainnetDeploy.s.sol` defaults to 7d.

6. **`maxAutomaticTokenAssociations = 0` by default on contracts.**
   Without that or an admin key set at create time, ANY HTS token transfer
   TO the contract reverts with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT (167)`.
   Two-pronged fix:
   (a) `_afterInitShareToken()` virtual hook in `SYBase`. `SY_HBARX`
       self-associates `underlying`. `SY_SaucerSwapV2LP` self-associates
       `token0` + `token1`. `FissionMarket` / `FissionMarketRewards`
       self-associate `sy.shareToken()` (and reward tokens) inside
       `setTokens`.
   (b) `deploy-mainnet-sdk.mjs` sets `setMaxAutomaticTokenAssociations(-1)`
       (HIP-904) on every `ContractCreate`.

7. **Tolerate response code 194 (`TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT`).**
   `HtsHelpers.associateIfNeeded` swallows 194 for idempotency. Without
   that, any path that re-runs association on an already-associated token
   reverts.

8. **SaucerSwap V2 NPM `mint` requires `msg.value` for the V3 NFT fee.**
   Cryptic revert string `"MF"` when calling contract has zero HBAR. NPM
   checks `selfbalance >= tinycentsToTinybars(usdMintFee)` — the V3 NFT
   creation fee is USD-cents-denominated, converted via Hedera's
   exchange-rate precompile. Fix: `SY_SaucerSwapV2LP.depositLiquidity` is
   `payable` and forwards `msg.value` to `npm.mint{value: msg.value}`.
   `increaseLiquidity` is symmetric. The init script attaches ~5 HBAR.

9. **`_burnYt` failed on frozen YT holders.**
   HTS rejects `wipeTokenAccount` on frozen accounts with response code
   165 (`ACCOUNT_FROZEN_FOR_TOKEN`). YT is frozen post-receive (AMM-only)
   so any `merge` / post-expiry redeem / YT-burning swap was unreachable.
   Fix in both Markets: unfreeze → wipe → refreeze if balance remains.

10. **`_mintLp(address(0xdEaD), MIN_LIQUIDITY)`** anti-griefing lock failed
    because `0xdEaD` isn't HTS-associated (response code 184). Fix:
    `_mintLp(address(this), MIN_LIQUIDITY)` — locked in market treasury,
    no withdraw path. Same effective behaviour on Hedera.

11. **HTS atomicity quirk on partial revert.**
    When `initialize()` reverted partway through, the HTS `transferFrom`s
    it had already done were NOT fully reverted by the EVM revert. State
    drift required a `merge()` recovery flow — and the unfreeze fix in
    `_burnYt` (#9) was needed to make recovery reachable.

12. **`optimizer_runs = 200`** (was `1_000_000`). 33% smaller bytecode;
    needed to fit the deployers under the gas cap. Re-check your function
    selectors are still cheap if you bump this back up.

## Appendix B — Final-factory cutover (Phase C)

The currently-deployed FissionFactory (`deployments/295.json`) ships with
`SY_REVIEW_WINDOW=0` and was used for the V2 LP smoke-test market only
("Market 0"). It is NOT the production factory.

Before launching for real users, run the full Phase C below. The 7-day
window is non-negotiable for production — it is the Penpie defence
(factory whitelist + public review window), one of the v1 launch
blockers. Schedule it at the **very end** of the deploy timeline so
nothing else is gated on it.

### Phase C HBAR budget (mainnet, observed)

| Step | Action | HBAR cost |
|------|--------|----------:|
| C-1  | Deploy fresh FissionFactory (SDK FileService path; 7d window) | ~30 |
| C-2  | Deploy fresh `SY_HBARX` (with all 12 bug fixes baked in)      | ~3  |
| C-3  | `initShareToken()` on new `SY_HBARX` (15 HBAR payable + ~1 fee) | ~16 |
| C-4  | `proposeSY` × 2 (HBARX + reuse SS-V2-LP)                       | <1  |
| C-5  | (wait 7 days — no HBAR cost, but operator must be available on day 8) | 0 |
| C-6  | `confirmSY` × 2                                                | <1  |
| C-7  | `createMarket` (HBARX-90D, FissionMarket — 3 HTS creates)      | ~60 |
| C-8  | `createRewardsMarket` (SS-V2-90D, FissionMarketRewards — 3 HTS) | ~60 |
| C-9  | Stake HBAR via Stader UI → HBARX (operator-pocket cost; no protocol cost) | ~30+ |
| C-10 | `initialize-hbarx-market.mjs` (deposit + split + initialize)   | ~3  |
| C-11 | `initialize-saucer-market.mjs` (HBAR→WHBAR→swap→deposit+split+initialize) | ~3 + seed |
| C-12 | `grantRole(KEEPER_ROLE, keeper)` on new SY_HBARX                | <1  |
| C-13 | First keeper rate post (post-grant)                             | <1  |
| C-14 | `beginDefaultAdminTransfer(safe)` × every contract              | ~2  |
| C-15 | Safe `acceptDefaultAdminTransfer()` × every contract            | ~2  |
| C-16 | `revokeRole` × all deployer roles                                | ~2  |
|      | **Subtotal protocol cost**                                       | **~213 HBAR** |
|      | + seed liquidity (your call) + Stader stake (~30+ HBAR)          |     |

Operator should top up to **≥250 HBAR plus seed budget** before starting.
HBAR balance EOD 2026-05-05 was ~351 HBAR — sufficient for Phase C if
seed liquidity is modest.

### Phase C step-by-step (with checkpoints)

#### Pre-flight (before any tx)
- [ ] Mutation testing report ≥85% kill in `audits/mutation/mutation-results.md`.
- [ ] External audit report committed in `audits/external/`.
- [ ] All audit findings of severity ≥ Medium have follow-up commits.
- [ ] Hedera 2-of-2 ThresholdKey account created (SDK `AccountCreateTransaction.setKey(ThresholdKey)`); account ID + EVM alias recorded.
- [ ] Timelock 48h deployed; proposer + executor = ThresholdKey account's EVM alias; admin = address(0); address recorded.
- [ ] Operator HBAR balance ≥ 250 HBAR + seed.
- [ ] HBARX (`0.0.834116`) associated to operator account.
- [ ] WHBAR + USDC associated to operator account.
- [ ] `forge test --no-match-path "test/fork/*"` green.
- [ ] `forge test --match-path "test/fork/*" --fork-url $HEDERA_MAINNET_RPC` green.
- [ ] `MAINNET_RPC` points at Validation Cloud or Arkhia (not Hashio).

#### Day 1 — kick off the 7-day clock

C-1. **Deploy fresh production factory** (with 7-day window).
```sh
SY_REVIEW_WINDOW_SECONDS=604800 \
ROUTER_ADDRESS=$(jq -r .router.evm deployments/295.json) \
SY_HBARX_ADDRESS=$(jq -r .sy_hbarx.evm deployments/295.json) \
SY_SAUCER_V2_LP_ADDRESS=$(jq -r .sy_saucer_v2_lp.evm deployments/295.json) \
node scripts/deploy-mainnet-sdk.mjs
```
- [ ] New factory address recorded; old factory address moved to `abandoned`.
- [ ] Verify factory's `SY_REVIEW_WINDOW()` returns `604800` (`cast call`).

C-2. **Deploy fresh SY_HBARX**.
```sh
node scripts/deploy-mainnet.mjs    # SY adapter sub-15M-gas, Hashio works
```
- [ ] New SY_HBARX address recorded; old `0x80728fbad79974e428c50dc548853ff858d9430c` moved to `abandoned`.

C-3. **`initShareToken` on new SY_HBARX** (must use SDK path, not Hashio).
```sh
node scripts/init-sy.mjs <new-sy-hbarx-evm> 15
```
- [ ] `shareToken()` returns a non-zero HTS token address.
- [ ] Self-association of `underlying` (HBARX) verified (transfer 1 wei test).

C-4. **proposeSY for both SYs**.
```sh
node scripts/propose-sy.mjs <new-factory-evm> <new-sy-hbarx-evm> $(jq -r .sy_saucer_v2_lp.evm deployments/295.json)
```
- [ ] Both `proposeSY` events emitted on-chain.
- [ ] Record proposal block timestamps.
- [ ] **Set a calendar reminder for day 8** to run C-6.

#### Day 2-7 — wait. Use the time wisely:
- HashScan UI verify the factory + SY_HBARX (`audits/hashscan/`).
- Provision the Safe + Timelock if not already done.
- Final spot-check with auditor.

#### Day 8 — confirm + create markets

C-6. **confirmSY for both** (reverts before 7 days have elapsed).
```sh
node scripts/confirm-sy.mjs <new-factory-evm> <new-sy-hbarx-evm> $(jq -r .sy_saucer_v2_lp.evm deployments/295.json)
```
- [ ] Both `confirmSY` events emitted.

C-7. **createMarket** (HBARX rate-growth market).
```sh
FACTORY_ADDRESS=<new-factory-evm> \
SY_HBARX_ADDRESS=<new-sy-hbarx-evm> \
SY_SAUCER_V2_LP_ADDRESS=$(jq -r .sy_saucer_v2_lp.evm deployments/295.json) \
STD_EXPIRY=$(($(date +%s) + 90*24*3600)) \
RWD_EXPIRY=$(($(date +%s) + 90*24*3600)) \
STD_SCALAR_ROOT=50e18 RWD_SCALAR_ROOT=75e18 \
STD_SUFFIX="HBARX-90D" RWD_SUFFIX="SS-V2-90D" \
node scripts/create-markets.mjs
```
- [ ] Both market addresses recorded; PT/YT/LP HTS tokens created.

C-9. **Stake HBAR via Stader UI** → HBARX in operator wallet. (User-driven step.)

C-10/C-11. **initialize each market** via the runbook scripts above.
- [ ] `lp_total_supply` non-zero on both markets.
- [ ] `lastLnImpliedRate` set; visible via `getMarketState()`.

C-12/C-13. **Grant KEEPER_ROLE** on new SY_HBARX, post first rate.
```sh
node scripts/grant-keeper.mjs <new-sy-hbarx-evm> $KEEPER_ADDRESS
# then start the keeper service per Step 6
```

#### Day 8+ — handoff to ThresholdKey-controlled Timelock

C-14/C-15/C-16. Run `node scripts/prep-handoff.mjs` to dump the
a Hedera-native batch: a `Timelock.scheduleBatch()` proposal signed 2-of-2,
followed 48h later by a `Timelock.executeBatch()` signed 2-of-2. The
helper script outputs both Hedera-SDK ContractExecuteTransaction snippets.
See Step 8 for the begin/accept dance for `DEFAULT_ADMIN_ROLE` itself.

- [ ] `hasRole(DEFAULT_ADMIN_ROLE, deployer) == false` on every contract.
- [ ] `hasRole(DEFAULT_ADMIN_ROLE, safe) == true` on every contract.
- [ ] Update `deployments/295.json`: new factory, new SY_HBARX, new
      markets, deployer-side roles cleared.
- [ ] Deploy frontend (Step 7) with the new addresses.
- [ ] Bootstrap Market 0 (`0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d`)
      remains on-chain but orphaned. Document in
      `deployments/295.json.abandoned.old_markets`.
