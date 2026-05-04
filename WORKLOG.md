# Fission Protocol — Hedera rebuild — full work log

**Repo:** https://github.com/penguinpecker/fission-protocol-hedera
**Status at log time:** 16 commits on `main`, last `b3a8fc6` (Mainnet deploy: preflight + deploy script + runbook). 128 tests, 127 passing + 1 fork-skipped. Code-complete; not externally audited.

This document captures the approach taken, what worked, what didn't, and what's still open. Written so it can be read cold by a future maintainer / auditor / contributor.

---

## 1. What was built

A from-scratch rebuild of the Pendle V2-style yield-tokenization protocol on Hedera Mainnet (chain ID 295), replacing the existing penguinpecker/fission-protocol repo (which had real bugs — see §4).

Three deliverables:

- **Smart contracts** (`contracts/`): Foundry-first Solidity, ~2300 LOC across 11 source files. Pendle V2-faithful AMM math, ERC-5115 (Pendle superset) SY adapters, HBARX/SaucerSwap-V1-LP/Bonzo-USDC adapters, Factory + Market + Router with Safe + Timelock governance hooks.
- **Frontend** (`frontend/`): Next.js 15 + React 19 + wagmi 2.14 + viem 2.21 + Tailwind. 4 routes: landing, markets list, single-market trade, 404. Real on-chain reads (no synthetic data).
- **Keeper** (`keeper/`): TypeScript + viem rate-poster service, dockerized. Reads Stader / SaucerSwap V1 pool / Bonzo Aave-fork; posts to SY adapters with bps + interval gating.

128 tests, 4 invariants × 128K random calls each. 0 high / 0 medium Slither findings after triage. Aderyn run committed as a baseline with H/L findings triaged.

---

## 2. Architecture decisions and rationale

| Decision | Rationale |
|---|---|
| Foundry-first for tests; Hardhat only for Hedera deploy + verify | Foundry has invariant fuzzing, Halmos-compatible test files, gas snapshots; Hardhat plays well with Hashio + Sourcify-via-HashScan. Best of both. |
| Pendle V2-faithful math (port `MarketMathCore`) | The previous repo's AMM had no `lastLnImpliedRate` anchor — curve drifted between blocks with no trades; large swaps drained at pre-swap prices. We persist `lastLnImpliedRate`, recompute `rateAnchor` each swap. |
| YT yield via global-index pattern with callback from YT to Market on every transfer | Without the callback, YT transfers leak accrued yield. Settling against *previous* balances before the transfer is the only correct order. |
| ERC-5115 Pendle superset (with `assetInfo`, reward indexes, `isValidTokenIn/Out`) | Pure EIP-5115 isn't enough — Pendle's PT/YT consumers depend on `assetInfo` returning `AssetType.{TOKEN, LIQUIDITY}` to know how to price PT in asset terms. |
| SaucerSwap **V1** LP as SY underlying (NOT V2) | V2 positions are NFTs with no per-share rate. V1 LPs are HTS-fungible ERC-20-facade tokens whose per-share value grows monotonically from swap fees (`sqrt(r0*r1)/totalSupply`). The "ERC20 read trick" the user remembered. V2 NFT-wrapping is deferred to a future v2 feature. |
| PT/YT decimals match the SY/asset (per Pendle) | Avoids per-market scaling at every entry point. PT.decimals == YT.decimals == SY.decimals == asset.decimals. |
| LP token decimals fixed at 18 | LP is its own unit of account; independent of the SY's decimals. |
| PT/YT as plain Solidity ERC-20 (NOT HTS-native) | The Foundry-testable ERC-20 path unblocks all subsequent phases without losing security or invariants. HTS-native PT/YT (HashPack visibility as native tokens) is a future optimization — adds gas and tooling complexity for marginal UX win. |
| Safe (multisig.hedera.foundation) + OZ TimelockController 48h, NOT custom multisig | Safe IS live on Hedera EVM as of mid-2025 (Palmera DAO). Reusing audited code beats writing our own. |
| Immutable cores; UUPS Router/adapters (when needed) | Pendle's hybrid stance. Cores can't be upgraded → no rug. Periphery can evolve via timelock. |
| `AccessControlDefaultAdminRules` over `Ownable2Step` | OZ 5.x recommendation: enforces single admin, 2-step transfer, mandatory delay, cancellable schedules. |
| Solidity 0.8.27, Cancun EVM, `viaIR`, optimizer 1M runs | Latest OZ-supported stable; Cancun is fine on Hedera EVM as of 2026 (transient-storage reentrancy guards work). |
| Keeper-posted SY rate with TWAP-6 ring-buffer median + 50bps/update cap + 200bps circuit breaker | Pendle Boros pattern. Even short TWAP windows materially raise atomic-sandwich attack cost. Circuit breaker auto-pauses on suspicious deviation between TWAP and a fresh on-chain oracle read. |
| Penpie defence: SY whitelist with 7-day public review window | Penpie lost $27M to a malicious SY registered against an unsuspecting market. Our `FissionFactory` requires `proposeSY` (event-logged), 7-day cooldown (contract-enforced, no bypass), then `confirmSY` before any market can use it. |
| HIP-904 conformance: every token-holding contract sets unlimited auto-association | Eliminates the manual `associateToken` boilerplate that broke half of the v1 protocol. |
| HIP-1217: only EVM-address aliases, never long-zero | A long-zero alias for an ECDSA account REVERTS in 2026 mainnet. Frontend reads `evm_address` from Mirror Node. |

---

## 3. Phase-by-phase log

### Phase 1 — Math libraries (`PMath`, `MarketMath`)
**Approach.** Wrote `PMath` as Solady-wrapping primitives with intent-revealing rounding-direction helpers (`mulWadDown`, `divWadUp`, etc.). Wrote `MarketMath` as a faithful port of Pendle's `MarketMathCore.sol`: persistent `lastLnImpliedRate`, `rateAnchor` recomputed each swap, fee on-rate (not on-amount).

**Worked.** Foundry fuzz at 5K runs surfaced no issues. Halmos-compatible specs (`test_prove_*`) pass at 5K runs and serve as proof obligations when `halmos` is run later.

**Didn't.** Initial test assertions on trade direction were wrong — I had buy/sell signs of `newLnImpliedRate` flipped. Buying PT shrinks PT supply in the pool → PT trades at less of a discount → implied yield goes DOWN, not UP. Math was correct; assertions were inverted. Caught immediately by the first test run.

### Phase 2 — `IStandardizedYield`, `SYBase`, `SY_HBARX`
**Approach.** Pendle superset interface (not pure EIP-5115). Abstract `SYBase` with `AccessControlDefaultAdminRules` + `ReentrancyGuardTransient` + Pausable. `SY_HBARX` is a keeper-posted-rate adapter with TWAP-6 + 50bps cap + 1h interval + 200bps circuit breaker.

**Worked.** Round-trip deposit→redeem fuzz at 5K runs verified protocol-favourable rounding.

**Didn't.** First circuit-breaker test failed — the `_pause()` call followed by `revert` was rolling back the pause. **Fix:** circuit breaker pauses **without reverting** (returns early after `_pause()` so the pause persists). The keeper's tx succeeds but the rate is silently dropped.

Also bumped into a subtle test bug: `vm.prank(admin)` is single-shot, but `sy.KEEPER_ROLE()` evaluates first and consumes the prank. Caching the role as a variable before the prank fixed it.

### Phase 3 — `PrincipalToken`, `YieldToken`
**Approach.** Plain ERC-20 with mint/burn gated to a single immutable `market` address. No pause on transfers (pausing would strand secondary-market holders).

**Worked.** 100% line + branch coverage on PT and YT — they're tiny and easy to exhaust.

**Didn't.** YT `_update` originally just emitted a `YTTransfer` event for indexer consumption — but that's not enough for yield accrual. Refactored in Phase 4 to call back to the Market via `IFissionMarket.onYTBalanceChange(from, to)` BEFORE the balance update. The market settles yield against pre-transfer balances, then YT updates.

### Phase 4 — `FissionMarket` + `FissionFactory` + invariant suite
**Approach.** Single-contract per maturity, inherits ERC-20 (LP token), holds SY, mints/burns PT/YT, runs the AMM. Yield accrual via global index synced lazily on every external entry. Post-expiry `globalIndex` freezes; PT redeems for `pt * 1e18 / globalIndex` SY.

**Worked.** All 4 invariants pass at 256 runs × 500 depth = 128K random calls each, **zero reverts** across ~20K calls per handler selector. The solvency invariant (`sy.balanceOf(market) * R >= pt.totalSupply * 1e18 + sumUserOwed * R`) is the headline.

**Didn't.** Hit `Built-in binary operator + cannot be applied to types int256 and uint256` early — over-engineered the int/uint conversion in swap state updates. Simplified to direct uint operations on the storage variables.

`initialize` was originally `onlyFactory`. Refactored to `onlyRole(ADMIN_ROLE)` so the factory can be a pure deployer with no token custody — the Safe seeds liquidity itself.

### Phase 5 — `ActionRouter`
**Approach.** Stateless multi-call helper: `depositAndSplit`, `swapExactSyForPt`, `swapExactPtForSy`, `buyYT`, `addLiquidityProportional`, `removeLiquidityProportional`, `redeemAfterExpiryAndUnwrap`, `unwrapSY`. Every external entry takes `(deadline, minOut)`.

**Worked.** All 13 router tests passed first try.

**Didn't.** Initial `depositAndSplit` had a `payable` qualifier with a fake `NATIVE_SENTINEL_OR_ZERO` constant that didn't exist on `IStandardizedYield`. Removed both: native-HBAR routing is deferred (HIP-906 helper), and the function is no longer `payable` (which Slither/Aderyn flagged as locked-ether risk).

`claimYieldAndUnwrap` was originally a one-tx flow but `market.claimYield()` keys on `msg.sender` — the router can't claim *for* the user without a `claimYieldFor(user)` market function. Two-tx flow (claim, then `router.unwrapSY`) is the v1 compromise.

### Phase 6a — `SY_SaucerSwapV1LP` (the ERC20-read trick)
**Approach.** Captures `initialVirtualPrice = sqrt(r0*r1) * 1e18 / totalSupply` at construction. `exchangeRate` reports a 1e18 ratio against this anchor. `assetType = LIQUIDITY` (per Pendle superset).

**Worked.** Same TWAP/bps/circuit-breaker machinery as `SY_HBARX`. Aave-fork-shaped Bonzo adapter followed the same template.

**Didn't.** First circuit-breaker test failed — I expected reserves boosted by 5% to push the SY ratio past 200bps deviation, but the calculation didn't account for `totalSupply` changing post-construction (alice's mint after SY init diluted the new virtual price). Moving alice's LP mint to BEFORE SY construction fixed the test arithmetic.

### Phase 6b — `SY_BonzoUSDC`
**Approach.** Mechanical copy of `SY_HBARX` with the oracle pointing at Bonzo's `getReserveNormalizedIncome(asset)`. Captures initial 1e27 ray index; reports `exchangeRate` as a 1e18 ratio.

**Worked.** 9 tests pass first try. assetType correctly returns `TOKEN` (USDC has a market price; not LIQUIDITY).

### Phase 7 — Frontend (Next.js 15 + wagmi/viem)
**Approach.** App Router + RSC. Wallet via wagmi `injected` connector — covers MetaMask + HashPack/Blade in EIP-1193 mode. Hashio for reads with env override to Validation Cloud / Arkhia for production.

**Worked.** All three pages (landing, markets list, market detail) build green. 25.6 kB / 151 kB first-load on /markets. The markets page shows a clean "factory not deployed" state when `NEXT_PUBLIC_FACTORY_ADDRESS` is unset — lights up automatically post-deploy.

**Didn't.** Native HashConnect (non-EVM HashPack) is deferred. EVM-injected covers the bulk of users in 2026 because HashPack and Blade ship EIP-1193 providers natively. Tx confirmation modal + real Mirror-Node charts are Phase 7d, gated on a live deploy to test against.

### Phase 8 — Keeper service
**Approach.** TypeScript + viem. Discriminated `RateSource` union (`stader | saucerswap-v1 | static`). Per-source fetchers in `src/sources/`. `postIfDue` reads SY paused/count/exchangeRate, mirrors the contract's bps cap as a defence-in-depth check, posts only if due.

**Worked.** TypeScript strict mode + `verbatimModuleSyntax` + `allowImportingTsExtensions` makes the imports `.ts`-suffixed (Node 22 requirement). Health server + Prometheus metrics on `:8080`. Three-stage Alpine Dockerfile builds clean.

### Phase 9-prep — Deploy scripts, governance docs, internal sec review
**Approach.** `script/Deploy.s.sol` for testnet/mainnet, `script/MainnetAddresses.sol` with pinned-and-verified Hedera mainnet addresses, `script/PreFlight.s.sol` ABI-pings every pinned address before broadcast, `script/MainnetDeploy.s.sol` refuses to broadcast unless `chainId == 295` and every privileged role is non-deployer. `docs/MAINNET_DEPLOY.md` is an 8-step runbook with an explicit "**not externally audited — operator risk**" warning. `SECURITY.md` + `CONTRIBUTING.md` cover bug-bounty plan and quality bars.

**Worked.** Slither baseline: 3 medium findings → all fixed (reentrancy-no-eth in factory by reordering effects-before-interactions; locked-ether on Router by dropping `payable`; locked-ether on SYBase by dropping the open `receive()`). Forge coverage: 78% line / 43% branch overall, 100% on PT/YT, 95% on MarketMath.

**Didn't.** `forge coverage` errors with "Stack too deep" on `executeTradeCore` under instrumentation. Fix: `--ir-minimum` flag (required, documented). The `viaIR + optimizer` production config is fine; only coverage instrumentation hits the limit.

The Aderyn run produced 2 H findings (locked-ether, state-change-after-external-call) — both false positives by the same logic Slither flagged: `payable deposit` is required by ERC-5115 spec and the function rejects `msg.value > 0` for non-NATIVE tokenIn; "external calls" before state changes are all `view` (e.g., `sy.exchangeRate()`, `assetInfo()`) so cross-function reentrancy isn't a real vector.

### Mainnet deploy artifacts
**Approach.** Verified addresses via Mirror Node + Bonzo docs: HBARX (`0.0.834116` / `0x...0cba44`), Stader staking contract (`0.0.1412503` / `0x...158d97`, holds HBARX supply key), USDC (`0.0.456858`), Bonzo LendingPool (`0.0.7308459` / `0x2368...`), Bonzo bUSDC (`0.0.7308496` / `0xB768...`).

**Didn't.** Stader's `getExchangeRate()` ABI is unverified — could not find an authoritative source for the function selector. Preflight script ABI-pings the contract and reverts if it doesn't return a 1e18-scaled rate in `[1.0, 5.0]`. SaucerSwap V1 HBAR-USDC LP address could not be located via search; deferred to operator (passed via `SAUCER_V1_LP` env var) with preflight ABI-validation.

---

## 4. Bugs in the previous repo (`penguinpecker/fission-protocol`) we did not repeat

These were observed during the line-by-line review of the existing live repo:

1. **AMM math had no rate anchor** — curve drifted blockwise; large swaps drained at pre-swap rates.
2. **Yield accrual paid from a balance with no inflow** — insolvent if rate ever exceeded 1e18.
3. **`Market 5` (the only seeded market) used a fake `SeedToken`** — 1000 fUSDC minted to deployer standing in for SaucerSwap LP. README claims SaucerSwap underlying.
4. **All admin/keeper/guardian roles held by deployer EOA** — single-key compromise = full drain.
5. **Zero unit tests shipped to mainnet.**
6. **PT redeems 1:1 instead of `pt * 1e18 / globalIndex`.**
7. **Frontend charts use `Math.random()` synthetic data.**
8. **`MARKET_COOLDOWN = 1 hour`** — operational pain (must run script, wait 60min, run again per market).

Every one of these is corrected in the rebuild. The mainnet deploy script is a hard guard: it refuses to broadcast if any privileged role address equals the deployer EOA.

---

## 5. What worked well

- **Foundry invariants** caught zero bugs because the math was clean from the start, but they ran 128K random calls and gave high confidence the conservation laws hold under arbitrary sequences.
- **Halmos-compatible spec-style tests** (`test_prove_*`) double as forge fuzz today and proof obligations later when halmos is wired in. Free upgrade path.
- **Slither + Aderyn parallel runs** — complementary detection. Slither caught the reentrancy ordering; Aderyn flagged the same locked-ether and added Solidity-pragma + unused-import noise. Two perspectives on the same code beat one.
- **The address pinning library + preflight script** — separating "what we deploy" from "where it points" means a misconfigured RPC can't ship to the wrong chain, and a wrong rate-source contract is caught before broadcast.
- **The decision tree in `MainnetAddresses.sol`** — every pinned address is annotated with how it was verified and what's still UNCONFIRMED. An auditor or future maintainer can trace the source.

---

## 6. What didn't work / had to be revised

- **Trying to install Foundry via Homebrew** — `brew install foundry` is the wrong package (a hardware tool with libusb dep); the EVM Foundry tap was removed. Direct GitHub release download via `gh release download` worked.
- **Initial GitHub push** — the OAuth token didn't have `workflow` scope, so `.github/workflows/*.yml` files couldn't push. Stashed in `.ci-staging/` until you grant `gh auth refresh -s workflow`. Workflows are committed locally and ready to move back.
- **Circuit-breaker pause + revert pattern** — `_pause()` followed by `revert` rolls back the pause. Switched to "pause without revert; silently drop the post" so the pause sticks.
- **`vm.prank` single-shot interaction with view function calls** — `vm.prank(admin); sy.grantRole(sy.KEEPER_ROLE(), keeper);` consumes the prank on `sy.KEEPER_ROLE()` (the inner view call). Cache the role first.
- **Forge coverage with viaIR + optimizer** — "Stack too deep" under instrumentation. Use `--ir-minimum`.
- **Aderyn arg names changed** — `--exclude` is `--path-excludes`, `--no-snapshot` is `--no-snippets`. CLI flux between versions.
- **macOS TCC permission revocation mid-session** — at log time, the Terminal app lost access to `~/Desktop`, blocking all file operations on the project. Not a code issue; user must re-grant access in System Settings → Privacy & Security → Files & Folders → Terminal → Desktop Folder ON.

---

## 7. Open issues / blockers / TODOs

### Blocking mainnet deploy

| Item | Owner | Status |
|---|---|---|
| Stader `getExchangeRate()` ABI verified on mainnet | operator | Preflight ABI-pings; reverts if shape wrong. Could be wrong selector — fallback: keeper fetches from Stader REST API. |
| SaucerSwap V1 HBAR-USDC LP address found | operator | Pass via `SAUCER_V1_LP` env. Preflight checks Uni-V2 ABI. **DO NOT use `0xc5b...11d` — that's V2 (NFT positions, incompatible).** |
| Safe + Timelock provisioned at multisig.hedera.foundation | operator | MainnetDeploy refuses to broadcast if any privileged role is deployer EOA. |
| External audit | operator | Recommend HashEx pre-audit ($30-50K, 2-3 weeks) → ChainSecurity primary ($150-200K, 6 weeks) → Code4rena/Sherlock contest → Immunefi bounty. |

### Code-quality gaps to close before audit

- **Branch coverage** at 43% overall. Production target 90%+ on core. Gaps mostly in revert paths in `FissionMarket` (post-expiry swap revert, ZeroAddress on every entry, slippage) and `ActionRouter` (deadline + slippage rejection paths).
- **Per-market pause** missing. `MAINNET_DEPLOY.md` rollback section flags this as a gap. Implement before mainnet.
- **Mutation testing** not yet run. `vertigo-rs` or `Gambit`. Target ≥85% kill rate on `MarketMath`, `FissionMarket`.
- **`forge fmt --check`** not enforced in CI yet (workflows still in `.ci-staging/`).
- **Fork tests** for SaucerSwap V1 LP and Bonzo USDC — currently only HBARX has a fork test scaffold, and even that is `[UNCONFIRMED]` for the Stader address.

### Phase 7d (frontend polish, gated on deploy)

- Tx confirmation modal with HashScan link.
- Real Mirror Node historical APY chart (no synthetic data — already gated).
- HashConnect connector for native HashPack support alongside EVM-injected.
- "Claim yield + unwrap" two-tx flow → one-tx (requires `market.claimYieldFor(user)`).

### Operational

- `gh auth refresh -s workflow` to push CI workflows from `.ci-staging/` to `.github/workflows/`.
- Provision Safe and TimelockController on Hedera mainnet via multisig.hedera.foundation.
- Verify Stader's exchange-rate function selector — Mirror Node bytecode disassembly or Stader docs / Discord.
- Find SaucerSwap V1 HBAR-USDC LP address — SaucerSwap subgraph or V1 frontend.

---

## 8. Audit pipeline recommendation (from research)

| Stage | Firm | Cost | Calendar |
|---|---|---|---|
| Pre-audit (Hedera-specialist) | HashEx or Hacken | $30-50K | 2-3 weeks |
| Primary audit | ChainSecurity (Pendle V2 + Boros experience) or Spearbit/Cantina | $150-200K | 6 weeks |
| Public contest | Code4rena or Sherlock | $80-120K prize pool | 14 days |
| Bug bounty | Immunefi | $50K cap, scaling to 10% TVL | ongoing post-launch |

**Total budget: $280-380K. Calendar: ~4 months from feature freeze to mainnet.**

ChainSecurity is the strongest candidate for primary because they audited Pendle V2 Core and Boros — they already know the rate-anchor + global-index patterns we ported. Their findings against Pendle (e.g., the SY exchange-rate monotonicity assumption, TWAP-window adversarial spam) inform the hardening already in our code.

---

## 9. Final state

```
.
├── contracts/
│   ├── src/
│   │   ├── core/                FissionFactory, FissionMarket, PrincipalToken, YieldToken
│   │   ├── sy/                  SYBase, SY_HBARX, SY_SaucerSwapV1LP, SY_BonzoUSDC
│   │   ├── periphery/           ActionRouter
│   │   ├── libraries/           PMath, MarketMath
│   │   └── interfaces/          IStandardizedYield, IFissionMarket, IStaderHBARX,
│   │                            IUniswapV2Pair, IAavePool
│   ├── test/
│   │   ├── unit/                10 unit + fuzz suites, 100+ tests
│   │   ├── invariant/           handler + 4 invariants × 128K calls
│   │   ├── symbolic/            5 Halmos-compatible specs
│   │   ├── fork/                Hedera mainnet fork harness (skipped without RPC)
│   │   └── mocks/               MockSY, MockSaucerV1Pool, MockAavePool, MockERC20
│   ├── script/                  Deploy, DeploySY_HBARX, MainnetDeploy, PreFlight,
│   │                            MainnetAddresses
│   ├── foundry.toml             default + ci + deep profiles
│   ├── medusa.json              fuzzer config (nightly)
│   ├── .slither-baseline.md     0 H/M; accepted lows documented
│   ├── .coverage-baseline.md    78% line / 43% branch; gates and gaps
│   └── hardhat.config.ts        for Hedera deploy + verify
├── frontend/
│   ├── src/
│   │   ├── app/                 RSC App Router, 3 pages (landing/markets/market detail)
│   │   ├── components/          Nav, Providers, FissionLogo
│   │   ├── hooks/               useMarkets (multicalled list), useMarket (detail)
│   │   └── lib/                 chains, wagmi, addresses, abis (read + write)
│   └── package.json             Next 15.1, React 19, wagmi 2.14, viem 2.21, Tailwind 3.4
├── keeper/
│   ├── src/
│   │   ├── sources/             stader, saucerSwapV1, dispatch
│   │   ├── post.ts              postIfDue
│   │   ├── health.ts            HTTP /health + /metrics
│   │   ├── types.ts             RateSource discriminated union
│   │   └── index.ts             main loop
│   ├── Dockerfile               three-stage Alpine; non-root; HEALTHCHECK
│   └── README.md
├── docs/
│   ├── ARCHITECTURE.md          design doc (Pendle math, SY strategy, Hedera HIPs)
│   ├── IMPLEMENTATION_PLAN.md   9-phase build plan with exit criteria
│   ├── DEPLOY.md                generic deploy runbook
│   └── MAINNET_DEPLOY.md        Hedera mainnet specifics with audit warning
├── audits/                      placeholder for external reports
├── deployments/                 will hold per-chain JSON post-deploy
├── .ci-staging/workflows/       CI workflows pending workflow-scope gh token
├── README.md, LICENSE (MIT), SECURITY.md, CONTRIBUTING.md
└── WORKLOG.md                   this file
```

**Tests:** 128 (127 pass + 1 fork-skipped). Run with `forge test`.
**Coverage:** `forge coverage --ir-minimum --no-match-path 'test/fork/*' --report summary`.
**Static analysis:** `slither src --filter-paths "lib|test"`, `aderyn --src src --path-excludes "lib,test,script"`.
**Build:** `forge build` (contracts), `npx next build` (frontend), `npm run build` (keeper).

**Last commit:** `b3a8fc6` (Mainnet deploy: preflight + deploy script + runbook).
**Last log update:** 2026-05-02.

---

## 10. Update — 2026-05-04

Two days after the §9 snapshot. Test count more than doubled (128 → 284). Below is the delta only — earlier sections are still accurate where they're not overridden here.

### 10.1 What landed

| Commit | Summary |
|---|---|
| `7c04b8c` | Per-market pause + follow-ups from the internal review (closes the gap §7 flagged before mainnet). |
| `5406438` | `SY_SaucerSwapV2LP` — Pendle-Kyber-style adapter for V3-fork concentrated LP. Uses SaucerSwap V2 NPM (the user revisited V1-vs-V2 and chose V2 with constant-rate + reward-token semantics). Replaces the Phase 6a V1 LP plan. |
| `8e5f36c` | `FissionMarketRewards` — sister Market for reward-bearing SYs whose `exchangeRate ≡ 1e18`. Same AMM/split/merge surface as `FissionMarket`; yield delivered to YT holders as token0/token1 swap fees, not via SY rate. |
| `0d615ed` | Drop dead Bonzo + V1 LP code; pin SaucerSwap V2 NPM mainnet address. |
| `da85cb7` | Mainnet deploy rewired to the v1 lineup: **HBARX + SaucerSwap V2 LP** (Bonzo dropped per user). |
| `a0eea5c` | SaucerSwap V2 stack: fix transfer-time harvest + redeem slippage; document expiry. |
| `a7f75e5` | Internal security review: 3 High + 4 Medium fixes documented in `audits/internal/SECURITY_REVIEW_2026-05-02.md`. |
| `0addef8` | Audit pass 2: close H-4 + M-1/M-4/M-5 + Lows + Hedera-aware findings. |
| `e8b6ab8` | Branch-coverage uplift: +93 revert-path tests (largely closes §7's "branch coverage at 43%" item). |
| `1c53474` | Fork tests against live Hedera mainnet + audit-aware runbook refresh. Stader `getExchangeRate()` confirmed 18-decimal (the §7-flagged unverified ABI). |
| `85dca96` | Frontend: multi-wallet picker (HashPack / Blade / MetaMask / generic injected) + accurate pre-launch copy. |
| `7731fd6`, `fbb4aef` | **HTS foundation, Phases 1 + 1.5.** Minimal precompile interface, typed `HtsHelpers` library wrapping the `0x167` precompile with safe int64 casts + reverts, `MockHederaTokenService` simulator at the precompile slot for unit tests, ERC-20 facade mock so `IERC20(htsToken)` calls work in Foundry. 12 smoke tests. **Foundation only — no production contract uses HTS yet.** |
| `437cfa6` | `IFissionMarketCommon` interface + `ActionRouter` parameterized on it. The router now drives both `FissionMarket` and `FissionMarketRewards`. Address-typed `ptAddr()`/`ytAddr()` helpers added (interface couldn't reuse the typed `pt()`/`yt()` auto-getters without a return-type clash). Zero math touched. |
| `994b72b` | E2e behavioral tests proving the router actually settles trades against `FissionMarketRewards`, not just satisfies the interface structurally. |

### 10.2 Stader exchange-rate ABI — confirmed

Fork test against Hedera mainnet read `1400809589212691785` from `getExchangeRate()` — clean **18-decimal scaling**, ~1.40 HBARX per HBAR. The 8-decimal note in earlier docs/research was wrong; thresholds and `IStaderHBARX.sol` ABI are now correct. Closes the §7 "Stader getExchangeRate() ABI verified" blocker.

### 10.3 SaucerSwap V1 LP — out, V2 LP in

§7 flagged the missing V1 HBAR-USDC LP address as a deploy blocker. Resolved by pivoting away from V1: `SY_SaucerSwapV2LP` (commit `5406438`) wraps a V3-fork concentrated-LP NFT instead. This required `FissionMarketRewards` because the V2 SY's `exchangeRate` is by-design constant `1e18` (Pendle-Kyber pattern) and yield flows through reward tokens. The V1 adapter, V1 mock, and Bonzo adapter are all deleted (`0d615ed`).

### 10.4 HTS architecture decision — explicitly revisited

§9's table says "PT/YT as plain Solidity ERC-20 (NOT HTS-native) — HashPack visibility is a future optimization." The user re-opened this on 2026-05-04: "wait this is definately wrong, initially we had planned to make most of the tokens HTS and not erc20." Two attempts at a full atomic HTS migration (PT + YT + LP + SY → HTS-native) rolled back this session — the SY/Market/Router test cascade exceeded the careful-no-math-mistakes budget per attempt. The HTS *foundation* (commits `7731fd6` + `fbb4aef`) is solid and committed; the migration of production contracts is parked for a dedicated session whose only goal is to shepherd that cascade green.

The `IFissionMarketCommon` refactor (`437cfa6`) helps the future migration: the router no longer cares which market kind it talks to, so changing PT/YT/LP token mechanics inside the markets won't ripple into router-side code.

### 10.5 Tests, static analysis, doc state

- **Tests:** 284 passing (was 128). 16 test suites: 11 unit, 3 invariant, 1 symbolic, 1 fork (skipped without `HEDERA_RPC_URL`).
- **Aderyn (re-run 2026-05-04):** 2 H + 8 L. Same set as the post-cleanup baseline; the only new line is L-8 *Unused Error* in `SY_HBARX.sol` (pre-existing, unrelated to recent work). `IFissionMarketCommon` introduced **zero** new findings.
- **Worklog rebuild:** §1's "11 source files" is now ~16 — see the §10.1 commit list. The §9 tree is also stale (`SY_SaucerSwapV2LP.sol`, `FissionMarketRewards.sol`, HTS interfaces and helpers, `IFissionMarketCommon.sol`). Treat the §9 tree as the *2026-05-02* snapshot, not current state.

### 10.6 What's still open

| Item | Note |
|---|---|
| HTS migration of production contracts (PT/YT/LP, possibly SY shares) | Foundation ready. Needs a dedicated session for the test cascade. |
| Mutation testing | Unstarted. Vertigo-rs / Gambit; target ≥85% kill rate on `MarketMath` + `FissionMarket`. |
| Frontend wiring for `FissionMarketRewards` paths | The router refactor unblocks this — frontend can now call the same router methods for either market kind. |
| Doc rebuild on `IMPLEMENTATION_PLAN.md` | Phase 5+ checkboxes still say `[ ]` even though everything ships. Updated alongside this entry — see `docs/IMPLEMENTATION_PLAN.md`. |
| Per-market pause | Landed in `7c04b8c` — close. |
| Branch coverage 90%+ | `e8b6ab8` added 93 revert-path tests, materially closing the gap §7 named. |

**Last commit at this update:** `994b72b` (ActionRouter: e2e behavioral coverage on FissionMarketRewards).
**Last log update:** 2026-05-04.

---

## 11. Update — 2026-05-04 (later same day) — HTS migration shipped

The HTS migration §10.4 parked is now done. **Every protocol token is HTS-native:**

| Phase | Commit | What |
|---|---|---|
| 2a | `4a75cff` | PT becomes HTS-native. Market is treasury + supplyKey + wipeKey. PrincipalToken contract obsoleted (kept as orphan source until 2c cleanup). |
| 2b | `f2b03ee` | YT becomes HTS-native + frozen (AMM-only). Market freezes every recipient post-mint (`_ytFrozen` map; `freezeDefault=false` because HIP-904 auto-association inherits the freeze default and would deadlock the mint). New `splitTo(amount, ptReceiver, ytReceiver)` so the router can mint YT directly to the user (router can't custody-and-forward frozen YT). New `seedBurnYt` admin helper to dispose of bootstrap-time YT residual. `redeemAfterExpiryAndUnwrap` drops its `ytIn` arg. `IFissionMarket.onYTBalanceChange` callback path is gone — yield/reward settlement is now explicit at every market entry. |
| 2c | `350e57d` | LP becomes HTS-native. FissionMarket / FissionMarketRewards no longer inherit ERC20. New `address public lp` + `lp()` interface getter; setTokens grows to 6 args (PT name+symbol, YT name+symbol, LP name+symbol). |
| cleanup | `5b5fb4e` | Delete vestigial `PrincipalToken.sol`, `YieldToken.sol`, `IFissionMarket.sol`, and their unit-test files (PT.t.sol/YT.t.sol). |
| docs | `3d84348` | Frontend ABIs refreshed (drop ERC-20 LP surface, add `lp()`/`assetDecimals()`/PT-YT-LP router helpers). Aderyn 2026-05-04 baseline appended to `.slither-baseline.md` — same 2 H as post-cleanup, two new lows are documented false positives (`pt`/`yt`/`lp` zero-check would never fire because `HtsHelpers.createFungible` reverts on non-SUCCESS; "unsafe-erc20" lints don't account for HTS facade reverting at network layer). |

**The yield-leakage exploit is closed at the protocol level.** The freeze-on-recipient YT design ensures a user can't sneak YT to a fresh address whose `userIndex` is stale and over-claim accrued yield.

### 11.1 Decimal scale realities

HTS amounts are `int64` (max 9.22e18). For tests originally written against an 18-decimal mock SY, `500_000e18 = 5e23` overflows int64. The mock-SY-driven tests were rescaled to 6 decimals (matching real Hedera tokens like USDC/HBARX which are 6/8-decimal). Math constants like `INITIAL_ANCHOR=1.05e18`, `SCALAR_ROOT=75e18`, `LN_FEE_ROOT=0.0003e18` stay 1e18-scaled (they're rates, not balances).

### 11.2 Trust model

| Token | Keys held by Market | Why |
|---|---|---|
| PT | SUPPLY, WIPE | Mint at split (treasury → user), wipe at merge / redeemAfterExpiry (burn from any account, replaces pre-HTS `_burn(from, amt)` under `onlyMarket`). |
| YT | SUPPLY, FREEZE, WIPE | Same as PT plus FREEZE. Market freezes every recipient post-receive so user-to-user transfers revert. Wipe lets `merge`/`redeemAfterExpiry` burn from frozen accounts (wipe bypasses freeze). |
| LP | SUPPLY, WIPE | Same as PT (transferable; no freeze — pausing trading would strand secondary-market holders). |

No ADMIN key, no PAUSE key on any token. The token configs are immutable post-create. Market is the auto-renew account on all three.

### 11.3 Tests / static analysis

- **Tests:** 265/265 passing (was 280 pre-cleanup; -15 from deleted PT.t.sol/YT.t.sol). All four invariants still hold under 128K random calls each.
- **Aderyn 2026-05-04:** 2 H + 10 L. No new real findings. See `.slither-baseline.md` for the post-migration appendix.
- **Frontend ABIs:** updated. `marketAbi` no longer has ERC-20 LP reads (they go through `IERC20(market.lp())` via `erc20Abi`). `routerAbi` covers all six router entry points.

### 11.4 Open items

| Item | Note |
|---|---|
| Mutation testing | Still unstarted. Vertigo-rs / Gambit; target ≥85% kill rate on `MarketMath` + `FissionMarket`. |
| Frontend wiring for rewards-market paths | Router now drives both market kinds; UI work to surface the V2-LP market in the markets list + trade view. |
| Hedera mainnet `createFungible` HBAR cost | Each market now creates THREE HTS tokens (was zero). Factory's `createMarket` is `payable` and forwards `msg.value`. Provisioning step: ensure deployer/Safe holds ~3 HBAR per market deployment. |
| External audit | Same recommendation as §8. The HTS migration adds new surface (token key model, freeze pattern, HIP-904 interaction) — worth flagging to the auditor as a focus area. |

**Last commit at this update:** `3d84348` (Frontend ABIs + slither baseline doc post-HTS migration).
**Last log update:** 2026-05-04 (HTS migration completed in this session).
