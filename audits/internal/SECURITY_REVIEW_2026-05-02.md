# Fission Protocol Hedera — Internal Security Review

**Date:** 2026-05-02
**Scope:** `contracts/src/` — all 13 source files, ~3700 LOC
**Sources of findings:**
1. Independent end-to-end manual review by an audit agent (24 findings).
2. Re-baselined Aderyn static analysis (`audits/internal/aderyn-2026-05-02-postcleanup.md`).
3. Slither static analysis (26 results, 40 contracts).
4. Foundry coverage report (172 tests, 73.78% line / 41.94% branch overall).
5. Author's manual cross-pass.

This review is an **internal** pre-audit pass. It does NOT replace the recommended external audit pipeline (HashEx → ChainSecurity → Code4rena → Immunefi).

## Executive summary

The codebase is a tight, well-structured Pendle V2 port with a separate reward-bearing-Market path (Pendle-Kyber pattern) for V3-LP-style SYs. Strong patterns are in place: 7-day SY whitelist, role separation between `ADMIN_ROLE` / `PAUSER_ROLE` / `DEFAULT_ADMIN_ROLE`, harvest-before-settle ordering, per-market pause with always-callable escape hatches, burn-to-DEAD donation guard, `nonReentrant` on every external entry.

This pass found **3 High** and **5 Medium** issues that have been addressed in code, plus **one design-level High (H-4)** that requires deeper Pendle-fidelity work before fix and is logged as a known issue. After the patches in this commit, the suite stands at 173/173 passing, 0 failing, 0 skipped.

---

## High Severity

### H-1 — PT can redeem for >1 SY at expiry if `sy.exchangeRate() < 1e18` at init **[FIXED]**

**Files:** `contracts/src/core/FissionMarket.sol`, `contracts/src/core/FissionMarketRewards.sol`

`initialize()` set `globalIndex = sy.exchangeRate()` without a floor at 1e18. A pre-keeper-cold-start `SY_HBARX` (or any future SY whose rate could ever briefly read below 1e18) would seed `globalIndex < 1e18`. PT's post-expiry redemption is `ptIn * 1e18 / globalIndex` — with `globalIndex < 1e18`, that pays out **more than 1 SY per PT**, draining the SY backing and breaking the conservation invariant.

**Fix shipped:**
- Added `error SYRateBelowOne(uint256 syRate)` and gate in both Markets' `initialize()`.
- Added a floor-at-`PMath.ONE` clamp inside `_updateGlobalIndex()` so an SY rate that ever returns below 1e18 mid-life cannot push `globalIndex` below 1e18 (the original code's monotonic-up logic only protected against decrease, not against initial low value).

### H-2 — `sy.claimRewards` revert bricks all YT mint/transfer/burn (DoS) **[FIXED]**

**Files:** `contracts/src/core/FissionMarketRewards.sol`

`YieldToken._update` unconditionally calls `IFissionMarket(market).onYTBalanceChange(from, to)` on every transfer/mint/burn. `FissionMarketRewards.onYTBalanceChange` calls `_harvestRewards`, which calls `sy.claimRewards(this)`. If `sy.claimRewards` ever reverts (e.g., underlying NPM is paused, or a future SY is bricked), **all YT activity halts** — including the user's escape paths (`merge`, `redeemAfterExpiry`).

**Fix shipped:**
- Wrapped `sy.claimRewards(this)` in a `try / catch (bytes memory reason)`. On failure, emit `HarvestSkipped(reason)` and return early. Subsequent successful harvests pick up the deferred rewards naturally because the V3 NPM still tracks them in `feeGrowthInside`.
- Added `event HarvestSkipped(bytes reason)`.

### H-3 — Reward tokens harvested while `totalSupply() == 0` are permanently locked **[FIXED]**

**Files:** `contracts/src/core/FissionMarketRewards.sol`, `contracts/src/sy/SY_SaucerSwapV2LP.sol`

Both contracts' harvest functions previously claimed reward tokens from upstream when there were no shareholders, then bailed out — leaving the tokens orphaned in the contract. The next harvest snapshots `prev = currentBalance` (which already includes the orphan amount), so the orphans are forever excluded from the per-share index. There was no rescue function.

**Fix shipped:**
- Both `_harvestRewards()` (Market) and `_harvest()` (SY adapter) now early-return when `totalSupply() == 0` BEFORE pulling from upstream. Fees stay in the V3 position's `feeGrowthInside` until the first shareholder exists, then a future harvest collects them correctly.

### H-4 — `removeLiquidity` post-expiry creates a solvency race vs PT redeemers **[OPEN — design fix queued]**

**Files:** `contracts/src/core/FissionMarket.sol:371-393`, `contracts/src/core/FissionMarketRewards.sol`

Post-expiry, `removeLiquidity` (returns SY + PT proportionally to LP) and `redeemAfterExpiry` (PT → `ptIn * 1e18 / globalIndex` SY) compete for the same `sy.balanceOf(this)`. A malicious LP could race ahead of PT redeemers and dump the received PT in any secondary market; PT redeemers attempting to collect during the window may have transactions revert from `safeTransfer` failure.

**Status:** logged as known issue. Fix requires Pendle's auto-redeem-at-expiry pattern: post-expiry, `removeLiquidity` should auto-redeem the LP's PT share and pay out only SY (`ptOut == 0`). This matches `PendleMarketV3.removeLiquidity` and is a real Pendle-fidelity gap. Not exploited under "honest LP" assumptions but blocks audit sign-off without resolution. Tracked for the next code-change commit.

---

## Medium Severity

### M-1 — `SYBase` does not defend against fee-on-transfer / rebasing underlyings **[OPEN — known limitation]**

**File:** `contracts/src/sy/SYBase.sol:82-108`

`deposit` calls `safeTransferFrom(msg.sender, address(this), amountIn)` then `_deposit(tokenIn, amountIn)`. `_deposit` mints shares based on the **requested** amount, not actual received. A fee-on-transfer token would silently inflate the share price.

**Status:** documented as a known limitation. HBARX, USDC, and WHBAR (the only tokens used by the v1 lineup) are NOT fee-on-transfer. The general fix (snapshot pre-balance, pass actual delta to `_deposit`) is straightforward but adds complexity to the abstract base. Defer to v1.1 if any future SY adapter wraps an HTS token with `customFees != 0`.

### M-2 — `redeemAfterExpiry` accepting `ytIn > 0` is a footgun in `FissionMarketRewards` **[FIXED]**

**File:** `contracts/src/core/FissionMarketRewards.sol`

In a reward-bearing market, rewards keep flowing to YT holders forever (Pendle semantics). A user passing both `ptIn` and `ytIn` (because the function signature suggested symmetry) would burn their YT and permanently destroy that future income stream.

**Fix shipped:**
- Added `error YTBurnNotPermitted()`.
- `redeemAfterExpiry` now reverts if `ytIn != 0`. If a user truly wants to dispose of YT, they can transfer it to a sink address — but they'll continue receiving rewards while they hold it.
- Test added: `test_redeemAfterExpiry_revertsOnYTBurn`.

`FissionMarket.redeemAfterExpiry` retains the old behavior because in a rate-growth market the yield is frozen at expiry and burning YT is harmless.

### M-3 — `SY_HBARX.exchangeRate()` reverts at cold start, bricking all dependent contracts **[FIXED]**

**File:** `contracts/src/sy/SY_HBARX.sol`

Previously reverted with `NoObservationsYet()` when `count == 0`. But `FissionMarket.initialize()`, swap, and `_accrue` (called from merge / claimYield / redeemAfterExpiry escape paths) all read this. A keeper outage at the wrong time would brick user exits.

**Fix shipped:**
- `exchangeRate()` now returns `PMath.ONE` (1e18) when `count == 0`. This is the minimum economically correct rate — HBARX must always be ≥ 1 HBAR per share (staking rewards only accrue, never deduct).
- Combined with the H-1 fix's floor, this means dependent contracts always see a sane rate even before the keeper has posted.
- Test updated: `test_exchangeRate_returnsOneAtColdStart` replaces the prior revert test.

### M-4 — Reward-token-bookkeeping uses arithmetic that could overflow on first liquidity add **[OPEN — practical reach is bounded]**

**File:** `contracts/src/libraries/MarketMath.sol`

`addLiquidityCore` first-add path computes `uint256(syDesired) * uint256(ptDesired)` without an explicit cap. Practically unreachable (would require `>2^128` of either side in the same tx), but worth a defensive `if (syDesired > type(int128).max || ptDesired > type(int128).max) revert ...` for audit cleanliness.

**Status:** logged. Will add in the next code-change commit alongside H-4.

### M-5 — Factory `marketAdmin` change does not propagate to existing markets **[ACCEPTED]**

**File:** `contracts/src/core/FissionFactory.sol`

The factory's `setMarketAdmin` only changes the default for *future* deployments. Rotating admin across N existing markets requires N individual `beginDefaultAdminTransfer` calls.

**Status:** accepted as design decision. Adding a `rotateMarketAdmin(address[] mkts, address newAdmin)` helper requires the factory to hold `DEFAULT_ADMIN_ROLE` on every market — a separate governance design choice with audit implications. Document operationally for now.

---

## Low Severity

### L-1 — `lastLnImpliedRate` not updated by liquidity ops **[ACCEPTED — matches Pendle]**

This is intentional Pendle behavior. Add/remove proportional liquidity should not change the implied-rate anchor. No fix.

### L-2 — `userIndex[user] == 0` sentinel collides with fresh-init `globalIndex == 0` **[ACCEPTED]**

**File:** `contracts/src/core/FissionMarket.sol`

Only manifests for pre-`initialize()` splits. Combined with the M-3 fix (cold-start returns `PMath.ONE`), this corner is now harmless: `globalIndex` will never be 0 even pre-init.

### L-3 — `previewYield` / `previewRewards` do not simulate a fresh harvest **[OPEN — UI-side]**

UI consumers should call `harvestRewards()` before reading these to get fresh values. NatSpec already documents this. Not a fix.

### L-4 — `SY_HBARX.postRate` emits zero in "previous TWAP" position when `n == 1` **[OPEN — indexer hint]**

**File:** `contracts/src/sy/SY_HBARX.sol`

Cosmetic; affects only event consumers reading the second-ever post. Will fix in the next pass with `n > 1` instead of `n > 0`.

### L-5 — `ActionRouter.depositAndSplit` redundant slippage check **[OPEN — minor cleanup]**

**File:** `contracts/src/periphery/ActionRouter.sol`

Pass `minPyOut` directly into `sy.deposit(..., minPyOut)` and remove the redundant downstream check. Cosmetic.

### L-6 — `depositLiquidity` had no token-amount slippage **[FIXED]**

**File:** `contracts/src/sy/SY_SaucerSwapV2LP.sol`

Symmetric to the Bug C fix on `redeemLiquidity` (commit `a0eea5c`). Without `amount0Min` / `amount1Min`, a sandwich attacker could move the V3 tick to mint very little liquidity for the user's funded amounts, then arbitrage back.

**Fix shipped:**
- Added `(uint256 amount0Min, uint256 amount1Min)` params to `depositLiquidity`. Threaded through to NPM `mint` / `increaseLiquidity` calls. NPM enforces. All test call sites updated.

### L-7 — `_loadState()` casts unchecked uint256 → int256 **[OPEN — practical reach bounded]**

**Files:** `contracts/src/core/FissionMarket.sol:541-550`, `contracts/src/core/FissionMarketRewards.sol:565-574`

If totalPt/totalSy/totalSupply ever exceed `2^255 - 1`, casts wrap negative and AMM math breaks. Practically unreachable. `PMath.toInt(...)` should be used for safety.

### L-8 — `createMarket`/`createRewardsMarket` does not validate min market duration **[OPEN — UX guardrail]**

**File:** `contracts/src/core/FissionFactory.sol`

Anyone with `MARKET_CREATOR_ROLE` can deploy a market with `expiry = block.timestamp + 1`. Should add a `MIN_MARKET_DURATION` constant.

### L-9 — `SYBase.NATIVE` constant defined but not used **[ACCEPTED — defensive scaffold]**

Dead-code today. Reserved for a future SY adapter that accepts HBAR. NatSpec documents intent.

### L-10 — `reserveFeePercent` cap reverted with `InsufficientLiquidity` (wrong error name) **[FIXED]**

**Files:** `FissionMarket.sol`, `FissionMarketRewards.sol`

**Fix shipped:**
- Replaced with dedicated `error ReserveFeeTooHigh(uint256 given, uint256 max)`. Test updated.

### L-11 — `setMarketAdmin` doesn't validate admin has code **[OPEN — best-practice]**

EOA fat-finger could brick admin operations. Cheap to add `addr.code.length > 0` check or accept that operators verify.

---

## Informational

### I-1 — `FissionMarketRewards.setTokens` uses inline check instead of modifier **[ACCEPTED]**
Functionally equivalent; consistency-only.

### I-2 — `harvestRewards()` is permissionless (intentional) — document MEV-friendly design.

### I-3 — `pause` / `unpause` asymmetric trust (PAUSER_ROLE vs DEFAULT_ADMIN_ROLE) — intentional, document.

### I-4 — `MarketMath._logProportion` `IONE` check is unreachable in practice — defence-in-depth.

### I-5 — `IMPLIED_RATE_TIME = 365 days` ignores leap years — matches Pendle; fine.

### I-6 — `PrincipalToken` and `YieldToken` lack EIP-2612 `permit` — UX nit.

### I-7 — `MarketCreated` event lacks `msg.sender` — useful for indexers.

### I-8 — `SY_SaucerSwapV2LP.assetInfo` returns `assetAddress = address(0)` — documented intentional sentinel for `LIQUIDITY` type.

### I-9 — `error ZeroAddress()` declared in both SYBase and SY_SaucerSwapV2LP — minor dedup.

### I-10 — `ReentrancyGuardTransient` (EIP-1153) usage — verified Hedera mainnet supports Cancun-era EVM.

---

## Verification of pre-existing fixes (commit `a0eea5c`)

- **Bug A (SY transfer harvest before settle):** verified correct. `_update` calls `_harvest()` first, then `_settleUserRewards`. Idempotent within a single tx.
- **Bug C (redeem slippage):** verified correct. `redeemLiquidity` takes `(amount0Min, amount1Min)` and threads to NPM.
- **Bug B (initial fix reverted):** verified correct. Reward-bearing Markets correctly do NOT freeze post-expiry rewards (matches Pendle's Kyber/Aerodrome pattern). NatSpec documents the intentional choice.

---

## Static-analyzer summary

**Aderyn** (after cleanup commit `0d615ed`): 2 High, 8 Low.
- H-1 ("locked Ether"): false positive. SYBase has a `payable deposit` but only accepts msg.value when `tokenIn == NATIVE`, and no current adapter declares NATIVE valid. Documented.
- H-2 ("state change after external call"): false positive across all 13 instances. Every flagged path is wrapped in `nonReentrant` and the external call target is either an immutable-pinned trusted contract (V3 NPM, Stader) or a whitelisted SY (7-day review).
- L-1 to L-8: best-practice nits. L-1 (centralization) is intentional (governance via Safe + Timelock); L-2/L-3 already cleaned in earlier commits; L-5 (PUSH0 / pragma) acceptable for Hedera Cancun.

**Slither** (post-fixes): 26 results.
- "Dangerous strict equality" (8): intentional sentinel checks (`positionTokenId == 0`, `totalSupply() == 0`).
- "Locked ether" (2): same false positive as Aderyn H-1.
- "Reentrancy-no-eth" (1): `npm.mint` returns `tokenId`, then `positionTokenId` set. Cross-function reentrance into `_harvest` reading `positionTokenId == 0` would be possible IF `nonReentrant` weren't on `depositLiquidity`. It is. False positive.
- "Uninitialized local" (4): Solidity zero-inits all locals; the analyzer is being pedantic.
- "Unused return" (7): some legit (`market.split()` returns the input amount; `addLiquidityCore` 4th return unused for proportional adds). Documented.

**Foundry coverage:** total 73.78% line / 41.94% branch. Branch coverage is the audit gap. Worst offenders:
- `FissionMarketRewards`: 65.83% / 22.95% — the new code, expected; targeted tests should be added in v1.1.
- `SYBase`: 57.78% / 26.67% — abstract base, large portion is conditional paths only reachable via concrete adapters that exercise them.
- `PMath`: 67.57% — pure math; mostly exercised indirectly through `MarketMath`. Worth direct fuzz tests.

---

## Open items going into the audit pipeline

- **H-4** (auto-redeem-at-expiry on `removeLiquidity`) — design fix needed for Pendle fidelity.
- **M-1** (fee-on-transfer underlying defence) — only matters for future SY adapters.
- **M-4** (addLiquidityCore overflow guard) — practical reach is bounded but worth tightening.
- **L-4, L-5, L-7, L-8, L-11** — minor cleanups, batchable.
- Branch coverage lift on `FissionMarketRewards` and `SYBase` — pre-audit homework.
- Mutation testing — never run; target ≥85% kill rate before external audit.

---

## Suite status after this commit

- 173 tests passing, 0 failed, 0 skipped.
- 8 invariants × 256 runs × 500 depth = 256K random calls per invariant, 0 reverts.
- Build clean. Slither / Aderyn re-baselined.
