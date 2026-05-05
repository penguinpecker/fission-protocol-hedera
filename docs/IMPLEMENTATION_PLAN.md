# Implementation Plan

Build order. Each phase has explicit exit criteria — no moving on until they're met.

## Status as of 2026-05-05

| Phase | Status | Notes |
|---|---|---|
| 0 — Scaffolding | **done** | Foundry + Hardhat + Slither + Aderyn + Medusa configs all green. |
| 1 — Math (`PMath`, `MarketMath`) | **done** | Halmos-compatible specs pass; Foundry fuzz at 5K runs surfaced no issues. |
| 2 — `SYBase`, `SY_HBARX` | **done** | Stader `getExchangeRate()` confirmed 18-decimal via mainnet fork (`1c53474`). Two-step init (`initShareToken()`) shipped — HTS createFungibleToken can't be called from a constructor on Hedera consensus. |
| 3 — PT, YT, Factory | **done** | PT/YT/LP are HTS-native. Factory shrunk from 71KB → 8KB by extracting `new FissionMarket(...)` and `new FissionMarketRewards(...)` into `StandardMarketDeployer` + `RewardsMarketDeployer` (Hedera's 15M-gas-per-tx ContractCreate cap can't deploy 71KB). |
| 4 — `FissionMarket` | **done** | 4 invariants × 128K calls, zero reverts. Conservation invariant holds. Constructor now takes explicit `factory_` param (with `address(0)` → `msg.sender` fallback for tests). |
| 5 — `ActionRouter` | **done (partial scope)** | Parameterized on `IFissionMarketCommon` (`437cfa6`) for both standard + rewards markets. Immutable in v1. **Shipped surface:** `depositAndSplit`, `swapExactSyForPt`, `swapExactPtForSy`, `buyYT`, `addLiquidityProportional`, `removeLiquidityProportional`, `redeemAfterExpiryAndUnwrap`, `unwrapSY`. **Deferred to v1.1** (require post-audit work): HBAR↔WHBAR auto-wrap (router currently ERC-20-only — HBAR-paying users wrap to WHBAR off-router), `swapExactYtForSy` (Pendle V2 flash-swap pattern), one-tx claim+unwrap (needs `market.claimYieldFor(user)`). |
| 6 — Second SY adapter | **scope changed** | V1 LP + Bonzo dropped; `SY_SaucerSwapV2LP` (Pendle-Kyber) shipped, plus sister Market `FissionMarketRewards` (`8e5f36c`). |
| 7 — Frontend | **wired** | Mainnet `.env.local` populated with all 4 contract addresses. Markets page returns 200; `marketCount === 0n` triggers the "Factory deployed — no markets yet" state correctly. Mirror Node APY chart + tx-confirmation modal gated on first market creation post-7d window. |
| 8 — Keeper | **done** | KEEPER_ROLE granted on SY_HBARX to operator EOA on mainnet (2026-05-05). Keeper service still needs to be pointed at the mainnet RPC and started in production. |
| 9 — Audit pipeline | **in progress** | 2 internal review passes shipped. Mutation testing + external audit not yet engaged. |
| 10 — **Mainnet deploy** | **live (PARTIAL — markets pending 7d window)** | Router + 2 SY adapters + 2 deployers + Factory all on chain 295. proposeSY done for both SYs at 2026-05-04T20:13Z; **confirm window opens 2026-05-11T20:13Z**. See `deployments/295.json`. |

**Tests:** 265 passing on `main` (post-pass-2 + V2-LP integration; verified 2026-05-06).
**Mainnet addresses:** see `deployments/295.json`. Operator EOA `0x32e8…ab90` / `0.0.10463169` is solo admin pending Safe + Timelock provisioning.
**Open gaps:** mutation testing, external audit, Hedera 2-of-2 ThresholdKey account + 48h OZ Timelock provisioning (no Safe contract — HTS-native governance), Sourcify full-match (currently `bytecode_hash = "none"` so only partial-match material is produced).

The unchecked `[ ]` boxes below are the *original 2026-04 build plan* — preserved for historical reference. Treat the table above as the authoritative status snapshot.

---

## Phase 0 — Scaffolding (done)

- Repo + tooling: Foundry + Hardhat + Slither + Aderyn + Medusa configs. CI green.
- Architecture decided (`ARCHITECTURE.md`).
- License, README, env template.

## Phase 1 — Math library (`src/libraries/PMath.sol`, `MarketMath.sol`)

The math is the foundation. Everything else fails if this is wrong.

- [ ] Port Solady `lnWad` / `expWad`.
- [ ] `PMath`: bps math, mulDiv (round up / round down), Q-format helpers.
- [ ] `MarketMath`: `getRateScalar`, `getExchangeRateFromImpliedRate`, `getRateAnchor`, `executeTradeCore`, `addLiquidityCore`, `removeLiquidityCore`. Pendle-faithful.
- [ ] **Halmos symbolic specs**: rounding always favours protocol; trade is reversible (swap A→B then B→A leaves user with ≤ original); `lastLnImpliedRate` post-update is consistent with the new (PT, SY) reserves.
- [ ] **Foundry fuzz**: 50K runs on every public function, bounded against realistic input ranges.

**Exit**: 100 % branch coverage, all Halmos specs pass, no unbounded-input reverts in fuzz.

## Phase 2 — SY base + first adapter (`SY_HBARX`)

HBARX is the simplest underlying — no LP math, just a Stader rate read.

- [ ] `SYBase.sol`: ERC-20 (asset-denominated decimals), reward index machinery, `assetInfo`, `previewDeposit/Redeem`. Round in protocol's favour everywhere.
- [ ] `SY_HBARX.sol`: keeper-posted rate with TWAP-6-buffer, bps caps, circuit breaker. Reads Stader contract directly for the source-of-truth rate.
- [ ] **Fork tests**: against Hedera mainnet at a pinned block. Deposit real HBARX, verify `exchangeRate()` matches Stader's published rate within tolerance.

**Exit**: fork tests pass, invariants hold under random keeper-rate inputs (within bps caps).

## Phase 3 — PT, YT, FissionFactory

This is where Hedera-native HTS integration lands.

- [ ] `PrincipalToken.sol` + `YieldToken.sol`: thin contracts that proxy to HTS. Supply key held by FissionMarket. ERC-20 facade automatic.
- [ ] `FissionFactory.sol`: deploys Market + creates PT/YT via HTS precompile in one tx. SY whitelist with 7-day review event log.
- [ ] HTS gas accounting: every operation that mints/burns budgets the precompile cost.
- [ ] Per-contract `maxAutomaticTokenAssociations = -1` set at construction.

**Exit**: end-to-end create → split → merge round-trip on Hedera testnet with HashPack visibility verified.

## Phase 4 — FissionMarket (the AMM)

- [ ] `FissionMarket.sol`: state struct, persisted `lastLnImpliedRate`, `executeTrade`, `addLiquidity`, `removeLiquidity`. Reentrancy-guarded transient.
- [ ] YT yield accrual: global index synced on every external entry that touches a user; per-user `userIndex`/`userYieldOwed`.
- [ ] Post-expiry: only `removeLiquidity` and `redeemPYAfterExpiry` allowed; surplus to treasury.
- [ ] **Foundry invariants**:
  - `totalSyHeld * globalIndex >= PT.totalSupply * 1e18 + sum(userYieldOwed) * globalIndex`
  - `totalPT in pool <= PT.totalSupply`
  - LP-supply consistency under add/remove sequences
  - Trade reversibility (round-trip leaves trader at ≤ original SY)
- [ ] **Medusa nightly** with the same invariants and a longer call-sequence depth.

**Exit**: all invariants pass at 50K Foundry runs and overnight Medusa, no shrunk counterexamples.

## Phase 5 — ActionRouter

- [ ] `ActionRouter.sol` (UUPS upgradeable): `depositAndSplit`, `swapExactSyForPt`, `swapExactPtForSy`, `swapExactSyForYt`, `swapExactYtForSy` (flash-mint pattern), `addLiquidityProportional`, `removeLiquidityProportional`, `redeemAfterExpiry`.
- [ ] HBAR↔WHBAR auto-wrap path so users can pay with native HBAR.
- [ ] HTS auto-association on user receive.
- [ ] Slippage params on every external entry — never `minOut = 0` internally.

**Exit**: testnet end-to-end happy path + 5 attack scenarios (front-run, sandwich, donation, rate-spike, expired-deadline) all behave as expected.

## Phase 6 — SY_SaucerSwapV1LP + SY_BonzoUSDC

- [ ] `SY_SaucerSwapV1LP.sol`: TWAP price oracle for HBAR/USDC, `exchangeRate = (r0 * p_twap + r1) / totalSupply`. `assetType = LIQUIDITY`.
- [ ] `SY_BonzoUSDC.sol`: read Bonzo's `getReserveNormalizedIncome` directly. `assetType = TOKEN`.
- [ ] Fork tests against mainnet.

**Exit**: real-deposit → split → wait 24h → claim → match expected APR within 5 bps.

## Phase 7 — Frontend

- [ ] Next.js 15 + RSC + App Router.
- [ ] Wallet: HashConnect (HashPack/Blade) + WalletConnect for MetaMask. Auto-detect.
- [ ] Mirror Node integration for historical TVL/APR charts (no synthetic data).
- [ ] HTS auto-association prompts where needed.
- [ ] Real-data charts: PT price history, implied APY history, both from Mirror Node + on-chain `getMarketState`.
- [ ] Strategy flows: Fixed yield (buy PT), Long yield (buy YT), Mint+LP (split + addLiquidity in one tx).

**Exit**: every chart sources real chain data; no `Math.random()` fixtures anywhere.

## Phase 8 — Keeper service

- [ ] TypeScript + Hedera SDK. Reads source-of-truth rates (Stader contract direct, SaucerSwap V1 reserves, Bonzo income index), posts to SY adapters with bps-bounded delta + min-interval gate.
- [ ] Runs in a dockerized container with restart-on-failure. Health-check endpoint.
- [ ] Alert hooks (Defender Sentinel + Telegram) on circuit-breaker trips.

**Exit**: 7 days of testnet runtime with 0 failed posts and rates tracking source within 50 bps.

## Phase 9 — Audit pipeline

- [ ] Final mutation-test pass; commit `gas-snapshot.txt`.
- [ ] Pre-audit: HashEx or Hacken.
- [ ] Primary audit: ChainSecurity / Spearbit. Address every finding before next phase.
- [ ] Code4rena or Sherlock contest. Address.
- [ ] Immunefi listing.
- [ ] **Mainnet deploy**: Hedera 2-of-2 ThresholdKey account + Timelock 48 h. Genesis: HBARX market only. SaucerSwap LP + Bonzo markets after 1 week of HBARX uptime.

## Definition of Done

The protocol is "production quality" when:

1. Every external function has a Foundry invariant or fuzz test that exercises its inputs.
2. Mutation kill rate ≥ 85 % on `MarketMath` and `FissionMarket`.
3. All Halmos specs on `MarketMath` pass.
4. Two external audit firms have signed off; one public contest has run with all H/M findings fixed.
5. Bug bounty live on Immunefi.
6. Multisig + Timelock are the sole owners of every privileged role.
7. Deployer EOA holds zero permissions on the live system.
8. Every UI surface that displays a number can be traced back to an on-chain or mirror-node read; nothing synthetic.
